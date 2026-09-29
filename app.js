require('dotenv').config()

const http = require('http')
const path = require('path')
const express = require('express')
const mongoose = require('mongoose')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { Server } = require('socket.io')

const metrics = require('./lib/metrics')
const { createGame, recoverRooms } = require('./lib/game')

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
const METRICS_PORT = Number(process.env.METRICS_PORT) || 9101
const JWT_SECRET = process.env.JWT_SECRET

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
    db: dbUp,
    version: process.env.APP_VERSION || 'dev'
  })
})

// ───────────────────────────────────────────────────────────
//  HTTP METRICS
// ───────────────────────────────────────────────────────────
//
// This middleware is BEFORE the rate limiter so 429 responses
// are counted too.
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

    metrics.httpRequestsTotal.inc(labels)
    metrics.httpRequestDuration.observe(labels, durationSeconds)
  })

  next()
})

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
})

// Only failed logins count. A group of friends on one Wi-Fi share an
// IP address, and successful logins used to lock them out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { message: 'Too many attempts. Try again in a few minutes.' }
})

// Enough for a whole party to sign up, few enough to stop bulk signups.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { message: 'Too many signups from this network. Try again later.' }
})

app.use(limiter)
app.use(express.static(path.join(__dirname, 'public')))

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`)
  next()
})

const authRouter = require('./routes/auth.js')
const roomRouter = require('./routes/rooms.js')
const leaderRouter = require('./routes/leaderboard.js')

app.use('/auth/login', loginLimiter)
app.use('/auth/signup', signupLimiter)
app.use('/auth', authRouter)
app.use('/rooms', roomRouter)
app.use('/leaderboard', leaderRouter)

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack || err)
  res.status(500).json({ error: 'Internal server error' })
})

// ───────────────────────────────────────────────────────────
//  SOCKETS
// ───────────────────────────────────────────────────────────

const server = http.createServer(app)

// Clients only ever send tiny messages. The default limit is 1 MB.
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 })

const game = createGame(io, { jwtSecret: JWT_SECRET })

// ───────────────────────────────────────────────────────────
//  DATABASE
// ───────────────────────────────────────────────────────────

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected')
    await recoverRooms()
    game.startSweeper()
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
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
    res.setHeader('Content-Type', metrics.register.contentType)

    const body = await metrics.register.metrics()

    res.end(body)
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
//  START AND STOP
// ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`)
})

// Docker sends SIGTERM on every deploy and waits 10 seconds before
// killing the process. Players are told first, running rooms are
// closed, and connections are shut cleanly within that window.
let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`${signal} received, shutting down`)

  setTimeout(() => process.exit(1), 8000).unref()

  try {
    await game.shutdown()
    // Give the "server restarting" message time to reach players.
    await new Promise(resolve => setTimeout(resolve, 500))
    await new Promise(resolve => io.close(() => resolve()))
    await new Promise(resolve => metricsServer.close(() => resolve()))
    await mongoose.disconnect()
  } catch (err) {
    console.error('clean shutdown failed:', err.message)
  }

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
