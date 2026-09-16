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
const QUESTION_COUNT = 50       // questions per game
const MAX_FINISHED_ROOMS = 5    // finished rooms kept in the DB; older ones are deleted

// ───────────────────────────────────────────────────────────
//  DATABASE
// ───────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected')
    // Game state lives in memory, so a restart kills every running game.
    // Any room still marked in-progress at boot is dead: mark it finished.
    const { modifiedCount } = await Room.updateMany(
      { status: 'in-progress' },
      { $set: { status: 'finished' } }
    )
    if (modifiedCount > 0) {
      console.log(`Marked ${modifiedCount} dead in-progress room(s) as finished`)
    }
    // Clear out old finished rooms, keeping the newest MAX_FINISHED_ROOMS.
    await pruneFinishedRooms()
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

// Keeps the newest MAX_FINISHED_ROOMS finished rooms and deletes the rest.
// Sorting by _id sorts by creation time (ObjectIds embed a timestamp).
// Waiting and in-progress rooms are never touched.
async function pruneFinishedRooms() {
  const keep = await Room.find({ status: 'finished' })
    .sort({ _id: -1 })
    .limit(MAX_FINISHED_ROOMS)
    .select('_id')

  const keepIds = keep.map(r => r._id)

  const { deletedCount } = await Room.deleteMany({
    status: 'finished',
    _id: { $nin: keepIds }
  })

  if (deletedCount > 0) {
    console.log(`Pruned ${deletedCount} old finished room(s)`)
  }
}

// ───────────────────────────────────────────────────────────
//  APP
// ───────────────────────────────────────────────────────────
const app = express()
app.set('trust proxy', 1)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Disable until this server is behind HTTPS/TLS.
      upgradeInsecureRequests: null
    }
  }
}))
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
  io.to(roomId).emit('new-question', {
    ...safeQuestion,
    number: state.currentQuestion + 1,   // 1-based, for "Question 12 of 50"
    total: state.questions.length        // real count, in case Gemini sent fewer
  })

  state.timer = setTimeout(() => {
    finishQuestion(roomId).catch(err => {
      console.error('question timer failed:', err.message)
    })
  }, QUESTION_MS)
}

async function finishQuestion(roomId) {
  const state = gameState[roomId]
  if (!state) return

  if (state.finishing) return

  state.currentQuestion++

  if (state.currentQuestion < state.questions.length) {
    sendQuestion(roomId)
    return
  }

  // Last question is done. Block any late "next" clicks while the
  // results are being saved below.
  state.finishing = true

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

  // Runs after players already got game-over, so a cleanup failure
  // can never break the end of a game.
  pruneFinishedRooms().catch(err => {
    console.error('pruning finished rooms failed:', err.message)
  })
}

// Usernames of everyone whose socket is currently in the room.
function connectedUsernames(roomId) {
  const socketIds = io.sockets.adapter.rooms.get(roomId) || new Set()
  const names = new Set()
  for (const id of socketIds) {
    const s = io.sockets.sockets.get(id)
    if (s && s.data.user) names.add(s.data.user.username)
  }
  return names
}

// ───────────────────────────────────────────────────────────
//  QUESTIONS (Gemini)
// ───────────────────────────────────────────────────────────
function isValidQuestion(q) {
  return Boolean(
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
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // JSON mode: makes a malformed reply much less likely on a big set
    generationConfig: { responseMimeType: 'application/json' }
  })

  const prompt = `Generate ${QUESTION_COUNT} random general knowledge quiz questions.
  Every question must be different. Mix topics and difficulty.
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

  // backup in case the model still wraps the JSON in markdown fences
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Gemini returned unparseable JSON')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini did not return an array')
  }

  // Drop only the malformed questions instead of failing the whole set,
  // and cap at QUESTION_COUNT in case the model sent extra.
  const questions = parsed.filter(isValidQuestion).slice(0, QUESTION_COUNT)

  if (questions.length === 0) {
    throw new Error('Gemini returned no usable questions')
  }
  if (questions.length < QUESTION_COUNT) {
    console.warn(`Gemini gave ${questions.length}/${QUESTION_COUNT} usable questions`)
  }

  return questions
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
        finishing: false,
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

    // Sent only after this player's answer is locked in, so it can't be
    // used to change their own answer.
    socket.emit('answer-result', {
      correct,
      correctOption: question.correctOption,
      scores: state.scores
    })
  })

  // "Next" button. Skips the rest of the 15s timer, but only when every
  // player still connected has answered. Otherwise one fast player could
  // skip the question for everyone else.
  socket.on('next-question', ({ number } = {}) => {
    const state = gameState[currentRoom]
    if (!state || state.finishing) return

    // Ignore a click meant for an older question (e.g. two players
    // clicked Next at the same moment and the first one already moved on).
    if (Number(number) !== state.currentQuestion + 1) return

    const players = connectedUsernames(currentRoom)
    const waiting = [...players].filter(name => !state.answered.has(name))

    if (waiting.length > 0) {
      socket.emit('next-blocked', { waitingFor: waiting.length })
      return
    }

    clearTimeout(state.timer)
    finishQuestion(currentRoom).catch(err => {
      console.error('next-question failed:', err.message)
    })
  })

  socket.on('disconnect', () => {
    if (!currentRoom) return

    io.to(currentRoom).emit('player-left', { socketId: socket.id })
    console.log(`user disconnected from ${currentRoom}:`, socket.id)

    const room = io.sockets.adapter.rooms.get(currentRoom)
    const roomSize = room ? room.size : 0

    if (roomSize === 0 && gameState[currentRoom]) {
      const roomId = currentRoom
      clearTimeout(gameState[roomId].timer)
      delete gameState[roomId]
      console.log(`Room ${roomId} is empty. Game state cleared.`)

      // Everyone left mid-game. Without this the room stays
      // "in-progress" forever and clutters the lobby.
      Room.updateOne({ _id: roomId, status: 'in-progress' }, { $set: { status: 'finished' } })
        .then(() => pruneFinishedRooms())
        .catch(err => console.error('closing abandoned room failed:', err.message))
    }
  })
})

// ───────────────────────────────────────────────────────────
//  START
// ───────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Server on port ${PORT}`))