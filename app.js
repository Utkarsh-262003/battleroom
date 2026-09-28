require('dotenv').config()

const http = require('http')
const path = require('path')
const express = require('express')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const client = require('prom-client')

const Room = require('./models/Room')
const GameResult = require('./models/GameResult')

// ───────────────────────────────────────────────────────────
//  CONFIG
// ───────────────────────────────────────────────────────────

const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET', 'GEMINI_API_KEY', 'PORT']
const missingEnv = REQUIRED_ENV.filter(name => !process.env[name])

if (missingEnv.length > 0) {
  console.error('Missing required environment variables: ' + missingEnv.join(', '))
  process.exit(1)
}

const PORT = process.env.PORT
const METRICS_PORT = 9101
const JWT_SECRET = process.env.JWT_SECRET
const QUESTION_MS = 15000
const QUESTION_COUNT = 15
const QUESTION_EXTRA = 5
const MAX_FINISHED_ROOMS = 5

const TOPICS = [
  'world geography', 'space and astronomy', 'Indian history', 'world history',
  'human body', 'animals', 'inventions', 'sports', 'movies', 'music',
  'computers and the internet', 'mathematics', 'chemistry', 'physics',
  'food and cooking', 'famous books', 'languages', 'mythology',
  'oceans', 'famous buildings', 'money and economics', 'video games'
]

const TOPICS_PER_GAME = 5

// ───────────────────────────────────────────────────────────
//  PROMETHEUS METRICS
// ───────────────────────────────────────────────────────────

const register = new client.Registry()

client.collectDefaultMetrics({
  register
})

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
})

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
})

const activeWebSocketConnections = new client.Gauge({
  name: 'active_websocket_connections',
  help: 'Number of currently connected WebSocket clients'
})

const activeGameRooms = new client.Gauge({
  name: 'active_game_rooms',
  help: 'Number of currently active game rooms'
})

register.registerMetric(httpRequestsTotal)
register.registerMetric(httpRequestDuration)
register.registerMetric(activeWebSocketConnections)
register.registerMetric(activeGameRooms)

// ───────────────────────────────────────────────────────────
//  DATABASE
// ───────────────────────────────────────────────────────────

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected')

    const { modifiedCount } = await Room.updateMany(
      { status: 'in-progress' },
      { $set: { status: 'finished' } }
    )

    if (modifiedCount > 0) {
      console.log(`Marked ${modifiedCount} dead in-progress room(s) as finished`)
    }

    await pruneFinishedRooms()
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

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
    console.log(`Pruned ${deletedCount} old finished rooms`)
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
      upgradeInsecureRequests: []
    }
  }
}))

app.use(express.json({ limit: '10kb' }))

// Health check intentionally sits BEFORE metrics.
// Docker healthchecks should not count as application traffic.
app.get('/healthz', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1

  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    db: dbUp
  })
})

// ───────────────────────────────────────────────────────────
//  HTTP METRICS
// ───────────────────────────────────────────────────────────
//
// This middleware is BEFORE the rate limiter so 429 responses
// are recorded as errors.
//
// It is AFTER /healthz so healthchecks are not counted.
//
// req.route is read inside "finish" because Express has not
// resolved the route yet when this middleware first runs.
//
// req.baseUrl + req.route.path gives the full route pattern:
//
// /rooms + /:id = /rooms/:id
//
// This avoids high-cardinality labels such as:
//
// /rooms/abc123
// /rooms/def456
// /rooms/xyz789
//

app.use((req, res, next) => {
  const start = process.hrtime.bigint()

  res.on('finish', () => {
    const durationSeconds =
      Number(process.hrtime.bigint() - start) / 1e9

    const route = req.route
      ? `${req.baseUrl}${req.route.path}`
      : 'unmatched'

    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode)
    }

    httpRequestsTotal.inc(labels)
    httpRequestDuration.observe(labels, durationSeconds)
  })

  next()
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

app.use((err, req, res, next) => {
  console.error(err.stack || err)
  res.status(500).json({ error: 'Internal server error' })
})

// ───────────────────────────────────────────────────────────
//  GAME STATE
// ───────────────────────────────────────────────────────────

const gameState = {}

function scoresOf(state) {
  const scores = {}

  for (const [username, p] of Object.entries(state.players)) {
    scores[username] = p.score
  }

  return scores
}

function updateActiveGameRoomsMetric() {
  activeGameRooms.set(Object.keys(gameState).length)
}

// ───────────────────────────────────────────────────────────
//  GAME FUNCTIONS
// ───────────────────────────────────────────────────────────

function sendQuestionTo(roomId, username) {
  const state = gameState[roomId]

  if (!state) return

  const p = state.players[username]

  if (!p || p.done) return

  const question = state.questions[p.index]
  const { correctOption, ...safeQuestion } = question

  p.answered = false

  io.to(p.socketId).emit('new-question', {
    ...safeQuestion,
    number: p.index + 1,
    total: state.questions.length
  })

  clearTimeout(p.timer)

  p.timer = setTimeout(() => {
    advancePlayer(roomId, username).catch(err => {
      console.error('question timer failed:', err.message)
    })
  }, QUESTION_MS)
}

async function advancePlayer(roomId, username) {
  const state = gameState[roomId]

  if (!state || state.finishing) return

  const p = state.players[username]

  if (!p || p.done) return

  clearTimeout(p.timer)

  p.index++

  if (p.index < state.questions.length) {
    sendQuestionTo(roomId, username)
    return
  }

  p.done = true

  io.to(p.socketId).emit('player-finished', {
    scores: scoresOf(state)
  })

  await finishGameIfEveryoneDone(roomId)
}

async function finishGameIfEveryoneDone(roomId) {
  const state = gameState[roomId]

  if (!state || state.finishing) return

  const allDone = Object.values(state.players).every(p => p.done)

  if (!allDone) return

  state.finishing = true

  const room = await Room.findById(roomId)
  const roomName = room ? room.name : 'unknown room'

  const results = Object.entries(state.players)
    .map(([username, p]) => ({
      username,
      userId: p.userId,
      score: p.score,
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

  io.to(roomId).emit('game-over', {
    scores: scoresOf(state)
  })

  delete gameState[roomId]

  updateActiveGameRoomsMetric()

  pruneFinishedRooms().catch(err => {
    console.error('pruning finished rooms failed:', err.message)
  })
}

function clearAllTimers(state) {
  for (const p of Object.values(state.players)) {
    clearTimeout(p.timer)
  }
}

// ───────────────────────────────────────────────────────────
//  QUESTIONS (GEMINI)
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

function pickTopics() {
  const shuffled = [...TOPICS].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, TOPICS_PER_GAME)
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchQuestions() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 1.0
    }
  })

  const askFor = QUESTION_COUNT + QUESTION_EXTRA
  const topics = pickTopics().join(', ')

  const prompt = `Generate ${askFor} quiz questions.
  Spread them across these topics: ${topics}.
  Every question must be about a different fact. No two questions may ask the same thing.
  Mix easy, medium and hard.
  Put the correct answer at a random position among the options.
  Return ONLY a JSON array, no markdown, no explanation, just the raw JSON.
  Format: [
    {
      "question": "question text",
      "options": ["option1", "option2", "option3", "option4"],
      "correctOption": 0
    }
  ]
  correctOption is the index of the correct answer in the options array.
  Random seed: ${Date.now()}`

  const result = await model.generateContent(prompt)
  const raw = result.response.text().trim()

  const cleaned = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Gemini returned unparseable JSON')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini did not return an array')
  }

  const seen = new Set()
  const questions = []

  for (const q of parsed) {
    if (!isValidQuestion(q)) continue

    const key = normalize(q.question)

    if (seen.has(key)) continue

    seen.add(key)
    questions.push(q)

    if (questions.length === QUESTION_COUNT) break
  }

  if (questions.length === 0) {
    throw new Error('Gemini returned no usable questions')
  }

  if (questions.length < QUESTION_COUNT) {
    console.warn(
      `Gemini gave ${questions.length}/${QUESTION_COUNT} usable questions`
    )
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

  activeWebSocketConnections.inc()

  console.log('socket authenticated:', user.username)

  let currentRoom = null

  socket.on('join-room', async ({ roomId }) => {
    try {
      const room = await Room.findById(roomId)

      if (!room) {
        socket.emit('error', { message: 'Room not found' })
        return
      }

      const isMember = room.players.some(
        p => p.toString() === user._id
      )

      if (!isMember) {
        socket.emit('error', {
          message: 'You have not joined this room'
        })
        return
      }

      currentRoom = roomId

      socket.join(currentRoom)

      io.to(currentRoom).emit('player-joined', {
        username: user.username
      })
    } catch (err) {
      console.error('join-room failed:', err.message)

      socket.emit('error', {
        message: 'Could not join room'
      })
    }
  })

  socket.on('start-game', async () => {
    try {
      if (!currentRoom) {
        socket.emit('error', {
          message: 'Join a room first'
        })
        return
      }

      if (gameState[currentRoom]) {
        socket.emit('error', {
          message: 'Game already in progress'
        })
        return
      }

      const room = await Room.findById(currentRoom)

      if (!room) {
        socket.emit('error', {
          message: 'Room not found'
        })
        return
      }

      if (room.host.toString() !== user._id) {
        socket.emit('error', {
          message: 'Only the host can start the game'
        })
        return
      }

      const questions = await fetchQuestions()

      if (gameState[currentRoom]) return

      const players = {}

      const socketIds =
        io.sockets.adapter.rooms.get(currentRoom) || new Set()

      for (const id of socketIds) {
        const s = io.sockets.sockets.get(id)

        if (!s || !s.data.user) continue

        players[s.data.user.username] = {
          userId: s.data.user._id,
          socketId: id,
          index: 0,
          score: 0,
          answered: false,
          done: false,
          timer: null
        }
      }

      if (Object.keys(players).length === 0) return

      room.status = 'in-progress'

      await room.save()

      gameState[currentRoom] = {
        questions,
        finishing: false,
        players
      }

      updateActiveGameRoomsMetric()

      io.to(currentRoom).emit('scores-update', {
        scores: scoresOf(gameState[currentRoom])
      })

      for (const username of Object.keys(players)) {
        sendQuestionTo(currentRoom, username)
      }
    } catch (err) {
      console.error('start-game failed:', err.message)

      socket.emit('error', {
        message: 'Could not start the game'
      })
    }
  })

  socket.on('submit-answer', ({ answer }) => {
    const state = gameState[currentRoom]

    if (!state || state.finishing) return

    const p = state.players[user.username]

    if (!p || p.done || p.answered) return

    p.answered = true

    const question = state.questions[p.index]

    if (!question) return

    const correct =
      Number(answer) === Number(question.correctOption)

    if (correct) {
      p.score += 10
    }

    const scores = scoresOf(state)

    socket.emit('answer-result', {
      correct,
      correctOption: question.correctOption,
      scores
    })

    io.to(currentRoom).emit('scores-update', { scores })
  })

  socket.on('next-question', ({ number } = {}) => {
    const state = gameState[currentRoom]

    if (!state || state.finishing) return

    const p = state.players[user.username]

    if (!p || p.done || !p.answered) return

    if (Number(number) !== p.index + 1) return

    advancePlayer(currentRoom, user.username).catch(err => {
      console.error('next-question failed:', err.message)
    })
  })

  socket.on('disconnect', () => {
    activeWebSocketConnections.dec()

    if (!currentRoom) return

    const roomId = currentRoom

    io.to(roomId).emit('player-left', {
      socketId: socket.id
    })

    console.log(
      `user disconnected from ${roomId}:`,
      socket.id
    )

    const state = gameState[roomId]

    if (!state) return

    const room = io.sockets.adapter.rooms.get(roomId)
    const roomSize = room ? room.size : 0

    if (roomSize === 0) {
      clearAllTimers(state)

      delete gameState[roomId]

      updateActiveGameRoomsMetric()

      console.log(
        `Room ${roomId} is empty. Game state cleared.`
      )

      Room.updateOne(
        {
          _id: roomId,
          status: 'in-progress'
        },
        {
          $set: { status: 'finished' }
        }
      )
        .then(() => pruneFinishedRooms())
        .catch(err =>
          console.error(
            'closing abandoned room failed:',
            err.message
          )
        )

      return
    }

    const p = state.players[user.username]

    if (p && p.socketId === socket.id && !p.done) {
      clearTimeout(p.timer)

      p.done = true

      finishGameIfEveryoneDone(roomId).catch(err => {
        console.error(
          'finishing game after disconnect failed:',
          err.message
        )
      })
    }
  })
})

// ───────────────────────────────────────────────────────────
//  METRICS SERVER
// ───────────────────────────────────────────────────────────

const metricsServer = http.createServer(async (req, res) => {
  if (req.url !== '/metrics') {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  try {
    res.statusCode = 200
    res.setHeader('Content-Type', register.contentType)

    const metrics = await register.metrics()

    res.end(metrics)
  } catch (err) {
    console.error('metrics generation failed:', err)

    res.statusCode = 500
    res.end('Could not generate metrics')
  }
})

metricsServer.listen(METRICS_PORT, () => {
  console.log(`Metrics server on port ${METRICS_PORT}`)
})

// ───────────────────────────────────────────────────────────
//  START
// ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`)
})