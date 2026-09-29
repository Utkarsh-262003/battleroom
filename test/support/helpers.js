// Starts the real app.js against an in-memory MongoDB and gives tests
// small helpers to drive it over HTTP and Socket.io.

const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { MongoMemoryServer } = require('mongodb-memory-server')
const { io } = require('socket.io-client')

const ROOT = path.join(__dirname, '..', '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function startMongo() {
  return MongoMemoryServer.create()
}

// Fast timings so a whole game fits in a few seconds.
const TEST_TIMINGS = {
  QUESTION_MS: '4000',
  RECONNECT_GRACE_MS: '1500',
  ROOM_SWEEP_MS: '300',
  ROOM_IDLE_MS: '1000'
}

async function startApp(mongo, env = {}) {
  const port = await freePort()
  const metricsPort = await freePort()
  const dbName = `test_${port}`

  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-gemini.js'), 'app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...TEST_TIMINGS,
      MONGO_URI: mongo.getUri(dbName),
      JWT_SECRET: 'test-secret',
      GEMINI_API_KEY: 'fake-key',
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })

  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  const base = `http://127.0.0.1:${port}`

  const app = {
    base,
    metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
    exited,
    log: () => output,
    geminiCalls: () => output.split('fake-gemini call').length - 1,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    // Resolves with the exit code.
    stop() {
      if (app.isRunning()) child.kill('SIGTERM')
      return exited
    }
  }

  // Ready means the HTTP server answers and MongoDB is connected.
  for (let i = 0; i < 100; i++) {
    if (!app.isRunning()) throw new Error('app exited during startup:\n' + output)
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) return app
    } catch { /* not listening yet */ }
    await sleep(100)
  }

  await app.stop()
  throw new Error('app did not become healthy:\n' + output)
}

async function request(app, method, url, body, token) {
  const res = await fetch(app.base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let data = null
  try { data = await res.json() } catch { /* not JSON */ }
  return { status: res.status, body: data }
}

let userCount = 0

async function makeUser(app, prefix = 'player') {
  userCount++
  const creds = {
    name: `Player ${userCount}`,
    email: `${prefix}${userCount}@example.test`,
    username: `${prefix}${userCount}`,
    password: 'password123'
  }
  const signup = await request(app, 'POST', '/auth/signup', creds)
  if (signup.status !== 200) throw new Error('signup failed: ' + JSON.stringify(signup.body))
  const login = await request(app, 'POST', '/auth/login', { email: creds.email, password: creds.password })
  if (login.status !== 200) throw new Error('login failed: ' + JSON.stringify(login.body))
  return { ...creds, token: login.body.token }
}

async function createRoom(app, host, name = 'Test room') {
  const created = await request(app, 'POST', '/rooms/create', { name }, host.token)
  if (created.status !== 200) throw new Error('create failed: ' + JSON.stringify(created.body))
  const roomId = String(created.body.roomId)
  await joinRest(app, host, roomId)
  return roomId
}

async function joinRest(app, user, roomId) {
  const joined = await request(app, 'POST', `/rooms/${roomId}/join`, undefined, user.token)
  if (joined.status !== 200) throw new Error('join failed: ' + JSON.stringify(joined.body))
}

// Records every event a socket receives, so tests can wait for one.
function recorder(socket) {
  const events = []
  const waiters = []

  socket.onAny((event, data) => {
    const entry = { event, data }
    events.push(entry)
    for (const w of [...waiters]) {
      if (w.matches(entry)) {
        waiters.splice(waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(entry)
      }
    }
  })

  // Resolves with the first event, from index `since` onwards, that
  // matches any of `specs`: a list of [eventName, matchFn?].
  function waitForAny(specs, timeoutMs = 5000, since = 0) {
    const matches = e => specs.some(([name, match = () => true]) => e.event === name && match(e.data))
    const seen = events.slice(since).find(matches)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const w = { matches, resolve }
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1)
        const wanted = specs.map(s => s[0]).join(' or ')
        reject(new Error(`timed out waiting for ${wanted}. Got: ${events.map(e => e.event).join(', ')}`))
      }, timeoutMs)
      waiters.push(w)
    })
  }

  return {
    events,
    waitForAny,
    waitFor(event, match = () => true, timeoutMs = 5000, since = 0) {
      return waitForAny([[event, match]], timeoutMs, since).then(e => e.data)
    },
    count(event) {
      return events.filter(e => e.event === event).length
    },
    mark() {
      return events.length
    }
  }
}

// Every socket a test opens, so after() can close any that are left.
// A forgotten socket keeps reconnecting and stops the test run exiting.
const openSockets = new Set()

function closeAllSockets() {
  for (const socket of openSockets) socket.close()
  openSockets.clear()
}

// Connects like the real client: joins the room on every (re)connect.
function connect(app, user, roomId) {
  const socket = io(app.base, {
    auth: { token: user.token },
    transports: ['websocket'],
    reconnectionDelay: 100,
    reconnectionDelayMax: 200
  })
  openSockets.add(socket)
  const rec = recorder(socket)
  if (roomId) socket.on('connect', () => socket.emit('join-room', { roomId }))
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  return { socket, rec, ready }
}

module.exports = {
  sleep,
  startMongo,
  startApp,
  request,
  makeUser,
  createRoom,
  joinRest,
  connect,
  closeAllSockets,
  recorder
}
