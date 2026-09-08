require('dotenv').config()

const http = require('http')
const path = require('path')
const express = require('express')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { GoogleGenerativeAI } = require('@google/generative-ai')

const Room = require('./models/Room')
const GameResult = require('./models/GameResult')

// ───────────────────────────────────────────────────────────
//  CONFIG — fail fast and loud if anything is missing
// ───────────────────────────────────────────────────────────
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET', 'GEMINI_API_KEY', 'PORT']
const missingEnv = REQUIRED_ENV.filter(name => !process.env[name])
if (missingEnv.length > 0) {
  console.error('Missing required environment variables: ' + missingEnv.join(', '))
  process.exit(1)
}

const PORT = process.env.PORT
const JWT_SECRET = process.env.JWT_SECRET
const QUESTION_MS = 15000

// ───────────────────────────────────────────────────────────
//  DATABASE
// ───────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

// ───────────────────────────────────────────────────────────
//  APP
// ───────────────────────────────────────────────────────────
const app = express()
app.set('trust proxy', 1)
app.use(helmet())
app.use(express.json({ limit: '10kb' }))

// Health check sits BEFORE the rate limiter on purpose:
// container healthchecks and uptime probes must never be rate limited.
app.get('/healthz', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp })
})

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
})
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests' }
})

app.use(limiter)
app.use(express.static('public'))

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`)
  next()
})

const authRouter = require('./routes/auth.js')
const roomRouter = require('./routes/rooms.js')
const leaderRouter = require('./routes/leaderboard.js')

app.use('/auth', authLimiter, authRouter)
app.use('/rooms', roomRouter)
app.use('/leaderboard', leaderRouter)

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'))
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Never send err.message to the client — it leaks stack traces,
// driver errors and file paths. Log the detail, return a generic body.
app.use((err, req, res, next) => {
  console.error(err.stack || err)
  res.status(500).json({ error: 'Internal server error' })
})

// ───────────────────────────────────────────────────────────
//  GAME STATE
// ───────────────────────────────────────────────────────────
const gameState = {}

function sendQuestion(roomId) {
  const state = gameState[roomId]
  if (!state) return

  state.answered = new Set()
  const question = state.questions[state.currentQuestion]
  const { correctOption, ...safeQuestion } = question
  io.to(roomId).emit('new-question', safeQuestion)

  state.timer = setTimeout(() => {
    finishQuestion(roomId).catch(err => {
      console.error('question timer failed:', err.message)
    })
  }, QUESTION_MS)
}

async function finishQuestion(roomId) {
  const state = gameState[roomId]
  if (!state) return

  state.currentQuestion++

  if (state.currentQuestion < state.questions.length) {
    sendQuestion(roomId)
    return
  }

  const room = await Room.findById(roomId)
  const roomName = room ? room.name : 'unknown room'

  const results = Object.entries(state.scores)
    .map(([username, score]) => ({
      username,
      userId: state.playerIds[username],
      score,
      roomName
    }))
    .filter(r => r.userId)

  if (results.length > 0) {
    await GameResult.insertMany(results)
  }

  if (room) {
    room.status = 'finished'
    await room.save()
  }

  io.to(roomId).emit('game-over', { scores: state.scores })
  delete gameState[roomId]
}

// ───────────────────────────────────────────────────────────
//  QUESTIONS (Gemini)
// ───────────────────────────────────────────────────────────
function isValidQuestionSet(data) {
  if (!Array.isArray(data) || data.length === 0) return false
  return data.every(q =>
    q &&
    typeof q.question === 'string' &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every(o => typeof o === 'string') &&
    Number.isInteger(q.correctOption) &&
    q.correctOption >= 0 &&
    q.correctOption <= 3
  )
}

async function fetchQuestions() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
  const prompt = `Generate 5 random general knowledge quiz questions.
  Return ONLY a JSON array, no markdown, no explanation, just the raw JSON.
  Format:
  [
    {
      "question": "question text",
      "options": ["option1", "option2", "option3", "option4"],
      "correctOption": 0
    }
  ]
  correctOption is the index of the correct answer in the options array.`

  const result = await model.generateContent(prompt)
  const raw = result.response.text().trim()

  // the model sometimes wraps the JSON in markdown fences
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Gemini returned unparseable JSON')
  }

  if (!isValidQuestionSet(parsed)) {
    throw new Error('Gemini returned a question set in the wrong shape')
  }

  return parsed
}

// ───────────────────────────────────────────────────────────
//  SOCKETS
// ───────────────────────────────────────────────────────────
const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server)

io.on('connection', socket => {
  let user
  try {
    user = jwt.verify(socket.handshake.auth?.token, JWT_SECRET)
  } catch {
    socket.disconnect(true)
    return
  }

  socket.data.user = user
  console.log('socket authenticated:', user.username)

  let currentRoom = null

  socket.on('join-room', async ({ roomId }) => {
    try {
      const room = await Room.findById(roomId)
      if (!room) {
        socket.emit('error', { message: 'Room not found' })
        return
      }

      // The client no longer decides who it is, and no longer decides
      // whether it is allowed in. Membership is checked against the DB.
      const isMember = room.players.some(p => p.toString() === user._id)
      if (!isMember) {
        socket.emit('error', { message: 'You have not joined this room' })
        return
      }

      currentRoom = roomId
      socket.join(currentRoom)
      io.to(currentRoom).emit('player-joined', { username: user.username })
    } catch (err) {
      console.error('join-room failed:', err.message)
      socket.emit('error', { message: 'Could not join room' })
    }
  })

  socket.on('start-game', async () => {
    try {
      if (!currentRoom) {
        socket.emit('error', { message: 'Join a room first' })
        return
      }
      if (gameState[currentRoom]) {
        socket.emit('error', { message: 'Game already in progress' })
        return
      }

      const room = await Room.findById(currentRoom)
      if (!room) {
        socket.emit('error', { message: 'Room not found' })
        return
      }
      if (room.host.toString() !== user._id) {
        socket.emit('error', { message: 'Only the host can start the game' })
        return
      }

      const questions = await fetchQuestions()

      room.status = 'in-progress'
      await room.save()

      gameState[currentRoom] = {
        currentQuestion: 0,
        scores: {},
        timer: null,
        answered: new Set(),
        playerIds: {},
        questions
      }

      sendQuestion(currentRoom)
    } catch (err) {
      console.error('start-game failed:', err.message)
      socket.emit('error', { message: 'Could not start the game' })
    }
  })

  socket.on('submit-answer', ({ answer }) => {
    const state = gameState[currentRoom]
    if (!state) return

    const username = user.username
    if (state.answered.has(username)) return
    state.answered.add(username)

    state.playerIds[username] = user._id
    if (state.scores[username] === undefined) state.scores[username] = 0

    const question = state.questions[state.currentQuestion]
    if (!question) return

    const correct = Number(answer) === Number(question.correctOption)
    if (correct) state.scores[username] += 10

    socket.emit('answer-result', { correct, scores: state.scores })
  })

  socket.on('disconnect', () => {
    if (!currentRoom) return

    io.to(currentRoom).emit('player-left', { socketId: socket.id })
    console.log(`user disconnected from ${currentRoom}:`, socket.id)

    const room = io.sockets.adapter.rooms.get(currentRoom)
    const roomSize = room ? room.size : 0

    if (roomSize === 0 && gameState[currentRoom]) {
      clearTimeout(gameState[currentRoom].timer)
      delete gameState[currentRoom]
      console.log(`Room ${currentRoom} is empty. Game state cleared.`)
    }
  })
})

// ───────────────────────────────────────────────────────────
//  START
// ───────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Server on port ${PORT}`))