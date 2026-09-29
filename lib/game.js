const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const Room = require('../models/Room')
const GameResult = require('../models/GameResult')
const { fetchQuestions } = require('./questions')
const metrics = require('./metrics')

// ───────────────────────────────────────────────────────────
//  SETTINGS
// ───────────────────────────────────────────────────────────
//
// The defaults are the real game. The environment overrides exist
// so the tests can play a whole game in a few seconds.

function msFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const QUESTION_MS = msFromEnv('QUESTION_MS', 15000)
const RECONNECT_GRACE_MS = msFromEnv('RECONNECT_GRACE_MS', 20000)
const ROOM_SWEEP_MS = msFromEnv('ROOM_SWEEP_MS', 60000)
const ROOM_IDLE_MS = msFromEnv('ROOM_IDLE_MS', 2 * 60 * 1000)

const MAX_FINISHED_ROOMS = 5
const BASE_POINTS = 10
const MAX_SPEED_BONUS = 10

// Each socket may send this many messages per window. Anything above
// that is dropped, so one client cannot flood the database.
const EVENT_LIMIT = 50
const EVENT_WINDOW_MS = 10000

// ───────────────────────────────────────────────────────────
//  HELPERS
// ───────────────────────────────────────────────────────────

function logError(what, err) {
  console.error(`${what} failed:`, err && err.message ? err.message : err)
}

// Socket payloads come straight from the client and can be anything,
// including null. Handlers only ever see a plain object.
function asObject(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

// Registers a socket handler that can never take the server down.
// Whatever it throws, sync or async, is logged and the message is
// dropped. The old handlers unpacked their payload in the parameter
// list, outside any try/catch, so `socket.emit('join-room', null)`
// crashed the process.
function on(socket, event, handler) {
  socket.on(event, (...args) => {
    const now = Date.now()
    const rate = socket.data.rate

    if (now - rate.start > EVENT_WINDOW_MS) {
      rate.start = now
      rate.count = 0
    }

    if (++rate.count > EVENT_LIMIT) return

    try {
      Promise.resolve(handler(...args)).catch(err => logError(event, err))
    } catch (err) {
      logError(event, err)
    }
  })
}

async function pruneFinishedRooms() {
  const keep = await Room.find({ status: 'finished' })
    .sort({ _id: -1 })
    .limit(MAX_FINISHED_ROOMS)
    .select('_id')

  const { deletedCount } = await Room.deleteMany({
    status: 'finished',
    _id: { $nin: keep.map(r => r._id) }
  })

  if (deletedCount > 0) {
    console.log(`Pruned ${deletedCount} old finished rooms`)
  }
}

// Game state lives in memory, so after a restart any game that was
// running is gone. Its room is closed so it does not sit in the lobby.
async function recoverRooms() {
  const { modifiedCount } = await Room.updateMany(
    { status: 'in-progress' },
    { $set: { status: 'finished' } }
  )

  if (modifiedCount > 0) {
    console.log(`Marked ${modifiedCount} dead in-progress room(s) as finished`)
  }

  await pruneFinishedRooms()
}

// A correct answer is worth 10 points, plus up to 10 more for speed.
function pointsFor(elapsedMs) {
  const timeLeft = Math.min(QUESTION_MS, Math.max(0, QUESTION_MS - elapsedMs))
  return BASE_POINTS + Math.round(MAX_SPEED_BONUS * timeLeft / QUESTION_MS)
}

// ───────────────────────────────────────────────────────────
//  GAME
// ───────────────────────────────────────────────────────────

function createGame(io, { jwtSecret }) {
  // roomId -> { questions, finishing, players }
  // players and scores use null-prototype objects, so a player called
  // "__proto__" is just another key.
  const games = new Map()

  // Rooms whose question set is being generated right now. Stops a
  // double-click on Start from asking Gemini twice.
  const starting = new Set()

  // roomId -> last time someone was in the waiting room.
  const lastActive = new Map()

  let sweepTimer = null
  let closing = false

  function scoresOf(game) {
    const scores = Object.create(null)

    for (const [username, p] of Object.entries(game.players)) {
      scores[username] = p.score
    }

    return scores
  }

  function updateActiveGamesMetric() {
    metrics.activeGameRooms.set(games.size)
  }

  // Users with at least one socket in the room, one entry per user.
  // If a user has two tabs open, the newest socket wins.
  function connectedUsers(roomId) {
    const socketIds = io.sockets.adapter.rooms.get(roomId) || new Set()
    const users = new Map()

    for (const id of socketIds) {
      const s = io.sockets.sockets.get(id)
      if (s && s.data.user) {
        users.set(s.data.user.username, { ...s.data.user, socketId: id })
      }
    }

    return [...users.values()]
  }

  // Tells everyone in the room who is there and who is host.
  async function broadcastRoomState(roomId) {
    const room = await Room.findById(roomId).select('host status')

    if (!room) return

    const users = connectedUsers(roomId)
    const host = users.find(u => u._id === room.host.toString())

    io.to(roomId).emit('room-state', {
      status: room.status,
      host: host ? host.username : null,
      players: users.map(u => u.username)
    })
  }

  // ── Questions ────────────────────────────────────────────

  function emitQuestion(game, p) {
    if (!p.socketId) return

    const { correctOption, ...question } = game.questions[p.index]

    io.to(p.socketId).emit('new-question', {
      ...question,
      number: p.index + 1,
      total: game.questions.length,
      durationMs: QUESTION_MS,
      timeLeftMs: Math.max(0, QUESTION_MS - (Date.now() - p.sentAt)),
      answered: p.answered
    })
  }

  function sendQuestion(roomId, username) {
    const game = games.get(roomId)

    if (!game) return

    const p = game.players[username]

    if (!p || p.done) return

    p.answered = false
    p.sentAt = Date.now()

    emitQuestion(game, p)

    // The timer keeps running while a player is disconnected, so being
    // away costs you questions, the same as being slow.
    clearTimeout(p.timer)

    p.timer = setTimeout(() => {
      advancePlayer(roomId, username).catch(err => logError('question timer', err))
    }, QUESTION_MS)
  }

  async function advancePlayer(roomId, username) {
    const game = games.get(roomId)

    if (!game || game.finishing) return

    const p = game.players[username]

    if (!p || p.done) return

    clearTimeout(p.timer)

    p.index++

    if (p.index < game.questions.length) {
      sendQuestion(roomId, username)
      return
    }

    p.done = true

    if (p.socketId) {
      io.to(p.socketId).emit('player-finished', { scores: scoresOf(game) })
    }

    await finishGameIfEveryoneDone(roomId)
  }

  function clearGameTimers(game) {
    for (const p of Object.values(game.players)) {
      clearTimeout(p.timer)
      clearTimeout(p.graceTimer)
    }
  }

  async function finishGameIfEveryoneDone(roomId) {
    const game = games.get(roomId)

    if (!game || game.finishing) return

    if (!Object.values(game.players).every(p => p.done)) return

    game.finishing = true
    clearGameTimers(game)

    const scores = scoresOf(game)

    try {
      const room = await Room.findById(roomId)
      const roomName = room ? room.name : 'unknown room'

      const results = Object.entries(game.players)
        .map(([username, p]) => ({ username, userId: p.userId, score: p.score, roomName }))
        .filter(r => r.userId)

      if (results.length > 0) {
        await GameResult.insertMany(results)
      }

      if (room) {
        room.status = 'finished'
        await room.save()
      }
    } finally {
      // Even if saving fails, the players get their final screen and
      // the game is removed from memory.
      io.to(roomId).emit('game-over', { scores })
      games.delete(roomId)
      updateActiveGamesMetric()
    }

    pruneFinishedRooms().catch(err => logError('pruning finished rooms', err))
  }

  // ── Starting a game ──────────────────────────────────────

  async function startGame(socket) {
    const user = socket.data.user
    const roomId = socket.data.roomId

    if (!roomId) {
      socket.emit('error', { message: 'Join a room first' })
      return
    }

    if (games.has(roomId) || starting.has(roomId)) {
      socket.emit('error', { message: 'The game has already started' })
      return
    }

    starting.add(roomId)

    let announced = false
    let started = false

    try {
      const room = await Room.findById(roomId)

      if (!room) {
        socket.emit('error', { message: 'Room not found' })
        return
      }

      if (room.host.toString() !== user._id) {
        socket.emit('error', { message: 'Only the host can start the game' })
        return
      }

      if (room.status !== 'waiting') {
        socket.emit('error', { message: 'This room has already played its game' })
        return
      }

      io.to(roomId).emit('game-starting')
      announced = true

      let questions

      try {
        questions = await fetchQuestions()
        metrics.questionGenerations.inc({ outcome: 'success' })
      } catch (err) {
        metrics.questionGenerations.inc({ outcome: 'failure' })
        throw err
      }

      const players = Object.create(null)

      for (const u of connectedUsers(roomId)) {
        players[u.username] = {
          userId: u._id,
          socketId: u.socketId,
          index: 0,
          score: 0,
          answered: false,
          done: false,
          sentAt: 0,
          timer: null,
          graceTimer: null
        }
      }

      // Everyone left while the questions were being generated.
      if (Object.keys(players).length === 0) return

      room.status = 'in-progress'
      await room.save()

      const game = { questions, finishing: false, players }

      games.set(roomId, game)
      updateActiveGamesMetric()
      started = true

      io.to(roomId).emit('scores-update', { scores: scoresOf(game) })

      for (const username of Object.keys(players)) {
        sendQuestion(roomId, username)
      }
    } catch (err) {
      logError('start-game', err)

      if (!announced) {
        socket.emit('error', { message: 'Could not start the game' })
      }
    } finally {
      starting.delete(roomId)

      if (announced && !started) {
        io.to(roomId).emit('start-failed', {
          message: 'Could not generate questions. The host can try again.'
        })
      }
    }
  }

  // ── Answers ──────────────────────────────────────────────

  function submitAnswer(socket, { answer }) {
    const roomId = socket.data.roomId
    const game = games.get(roomId)

    if (!game || game.finishing) return

    const p = game.players[socket.data.user.username]

    if (!p || p.done || p.answered || p.socketId !== socket.id) return

    if (!Number.isInteger(answer) || answer < 0 || answer > 3) return

    const question = game.questions[p.index]

    if (!question) return

    p.answered = true

    const correct = answer === question.correctOption
    const points = correct ? pointsFor(Date.now() - p.sentAt) : 0

    p.score += points

    const scores = scoresOf(game)

    socket.emit('answer-result', {
      correct,
      correctOption: question.correctOption,
      points,
      scores
    })

    io.to(roomId).emit('scores-update', { scores })
  }

  function nextQuestion(socket, { number }) {
    const roomId = socket.data.roomId
    const game = games.get(roomId)

    if (!game || game.finishing) return

    const username = socket.data.user.username
    const p = game.players[username]

    if (!p || p.done || !p.answered || p.socketId !== socket.id) return

    // The number stops a double-click from skipping a question.
    if (number !== p.index + 1) return

    return advancePlayer(roomId, username)
  }

  // ── Joining, leaving, reconnecting ───────────────────────

  // Puts a returning player back into a running game: they get the
  // current scores and the question they were on, with the time left.
  function resumeGame(socket, roomId) {
    const game = games.get(roomId)

    if (!game) return

    const p = game.players[socket.data.user.username]

    if (!p) return

    if (p.socketId && p.socketId !== socket.id) {
      io.to(p.socketId).emit('error', { message: 'This game continued in another tab' })
    }

    clearTimeout(p.graceTimer)
    p.socketId = socket.id

    const scores = scoresOf(game)

    socket.emit('scores-update', { scores })

    if (p.done) {
      socket.emit('player-finished', { scores })
    } else {
      emitQuestion(game, p)
    }
  }

  async function joinRoom(socket, { roomId }) {
    const user = socket.data.user

    // `code` lets the client send the player back to the lobby.
    const notFound = { message: 'This room no longer exists', code: 'room-gone' }

    if (typeof roomId !== 'string' || !mongoose.isValidObjectId(roomId)) {
      socket.emit('error', notFound)
      return
    }

    try {
      const room = await Room.findById(roomId)

      if (!room) {
        socket.emit('error', notFound)
        return
      }

      const isMember = room.players.some(p => p.toString() === user._id)

      if (!isMember) {
        socket.emit('error', { message: 'You have not joined this room', code: 'room-gone' })
        return
      }

      const previous = socket.data.roomId

      if (previous && previous !== roomId) {
        leaveRoom(socket, previous)
      }

      socket.data.roomId = roomId
      socket.join(roomId)
      lastActive.set(roomId, Date.now())

      io.to(roomId).emit('player-joined', { username: user.username })

      await broadcastRoomState(roomId)

      resumeGame(socket, roomId)
    } catch (err) {
      logError('join-room', err)
      socket.emit('error', { message: 'Could not join room' })
    }
  }

  // If the host of a waiting room is gone for good, the next player in
  // the room becomes host, so the room is not stuck.
  async function handOverHost(roomId, leftUserId) {
    const room = await Room.findById(roomId)

    if (!room || room.status !== 'waiting' || room.host.toString() !== leftUserId) return

    const users = connectedUsers(roomId)

    if (users.length === 0 || users.some(u => u._id === leftUserId)) return

    room.host = users[0]._id
    await room.save()

    await broadcastRoomState(roomId)
  }

  function leaveRoom(socket, roomId) {
    // During shutdown every socket disconnects at once. There is
    // nothing to hand over or save by then.
    if (closing) return

    const user = socket.data.user

    socket.leave(roomId)
    lastActive.set(roomId, Date.now())

    // A phone that reconnects often opens its new socket before the
    // server notices the old one is gone. The player has not left.
    const stillHere = connectedUsers(roomId).some(u => u.username === user.username)

    if (!stillHere) {
      io.to(roomId).emit('player-left', { username: user.username })
    }

    broadcastRoomState(roomId).catch(err => logError('room state', err))

    const game = games.get(roomId)

    if (!game) {
      setTimeout(() => {
        handOverHost(roomId, user._id).catch(err => logError('host handover', err))
      }, RECONNECT_GRACE_MS).unref()
      return
    }

    const p = game.players[user.username]

    if (!p || p.done || p.socketId !== socket.id) return

    // A dropped connection is not the end of your game. You have
    // RECONNECT_GRACE_MS to come back before you are counted as done.
    p.socketId = null
    clearTimeout(p.graceTimer)

    p.graceTimer = setTimeout(() => {
      if (p.socketId || p.done || games.get(roomId) !== game) return

      clearTimeout(p.timer)
      p.done = true

      finishGameIfEveryoneDone(roomId).catch(err => {
        logError('finishing game after disconnect', err)
      })
    }, RECONNECT_GRACE_MS)
  }

  // ── Waiting room cleanup ─────────────────────────────────

  // Deletes waiting rooms nobody has been in for ROOM_IDLE_MS. Before
  // this, a room whose players all left sat in the lobby forever.
  async function sweepWaitingRooms() {
    const rooms = await Room.find({ status: 'waiting' }).select('_id')
    const now = Date.now()
    const waitingIds = new Set()
    const stale = []

    for (const room of rooms) {
      const id = room._id.toString()
      const occupied = (io.sockets.adapter.rooms.get(id)?.size || 0) > 0

      waitingIds.add(id)

      if (occupied || starting.has(id) || games.has(id)) {
        lastActive.set(id, now)
        continue
      }

      const since = lastActive.get(id) ?? room._id.getTimestamp().getTime()

      if (now - since >= ROOM_IDLE_MS) stale.push(room._id)
    }

    for (const id of lastActive.keys()) {
      if (!waitingIds.has(id)) lastActive.delete(id)
    }

    if (stale.length === 0) return

    const { deletedCount } = await Room.deleteMany({
      _id: { $in: stale },
      status: 'waiting'
    })

    for (const id of stale) lastActive.delete(id.toString())

    if (deletedCount > 0) {
      console.log(`Removed ${deletedCount} abandoned waiting room(s)`)
    }
  }

  function startSweeper() {
    sweepTimer = setInterval(() => {
      sweepWaitingRooms().catch(err => logError('sweeping waiting rooms', err))
    }, ROOM_SWEEP_MS)

    sweepTimer.unref()
  }

  // Called on SIGTERM, for example during a deploy. Players are told
  // the server is restarting instead of watching a frozen question.
  async function shutdown() {
    closing = true
    clearInterval(sweepTimer)

    const roomIds = [...games.keys()]

    for (const game of games.values()) clearGameTimers(game)

    games.clear()
    updateActiveGamesMetric()

    io.emit('server-restarting')

    if (roomIds.length > 0) {
      await Room.updateMany(
        { _id: { $in: roomIds }, status: 'in-progress' },
        { $set: { status: 'finished' } }
      )
    }
  }

  // ── Sockets ──────────────────────────────────────────────

  // Only sockets with a valid token connect at all. The username
  // always comes from the verified token, never from the client.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token
      socket.data.user = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] })
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', socket => {
    socket.data.rate = { start: Date.now(), count: 0 }

    metrics.activeWebSocketConnections.inc()

    on(socket, 'join-room', payload => joinRoom(socket, asObject(payload)))
    on(socket, 'start-game', () => startGame(socket))
    on(socket, 'submit-answer', payload => submitAnswer(socket, asObject(payload)))
    on(socket, 'next-question', payload => nextQuestion(socket, asObject(payload)))

    socket.on('disconnect', () => {
      metrics.activeWebSocketConnections.dec()

      const roomId = socket.data.roomId

      if (!roomId) return

      try {
        leaveRoom(socket, roomId)
      } catch (err) {
        logError('disconnect', err)
      }
    })
  })

  return { startSweeper, shutdown }
}

module.exports = { createGame, recoverRooms }
