const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const {
  sleep, startMongo, startApp, request, makeUser, createRoom, joinRest, connect, closeAllSockets
} = require('./support/helpers')

let mongo
let app

before(async () => {
  mongo = await startMongo()
  app = await startApp(mongo)
})

after(async () => {
  closeAllSockets()
  if (app) await app.stop()
  if (mongo) await mongo.stop()
})

// Host and guest in one room, both connected, host confirmed as host.
async function setUpRoom(target = app) {
  const host = await makeUser(target, 'host')
  const guest = await makeUser(target, 'guest')
  const roomId = await createRoom(target, host)
  await joinRest(target, guest, roomId)

  const h = connect(target, host, roomId)
  const g = connect(target, guest, roomId)
  await Promise.all([h.ready, g.ready])

  await h.rec.waitFor('room-state', s => s.players.length === 2 && s.host === host.username)

  return { host, guest, roomId, h, g }
}

// The fake Gemini always writes the right answer as "right N".
function rightIndex(question) {
  return question.options.findIndex(o => o.startsWith('right'))
}

// Plays every remaining question for one player, then waits for the
// "you are finished" screen.
async function playAll(client, { correct }) {
  const positions = []
  let points = 0

  for (let number = 1; ; number++) {
    const next = await client.rec.waitForAny([
      ['new-question', q => q.number === number],
      ['player-finished']
    ], 8000)

    if (next.event === 'player-finished') break

    const q = next.data
    assert.equal('correctOption' in q, false, 'the answer is never sent early')

    const right = rightIndex(q)
    const answer = correct ? right : (right + 1) % 4
    const resultMark = client.rec.mark()

    client.socket.emit('submit-answer', { answer })
    const result = await client.rec.waitFor('answer-result', () => true, 5000, resultMark)

    positions.push(result.correctOption)
    points += result.points

    if (correct) {
      assert.equal(result.correct, true)
      assert.ok(result.points >= 10 && result.points <= 20, `points ${result.points}`)
    } else {
      assert.equal(result.correct, false)
      assert.equal(result.points, 0)
    }

    client.socket.emit('next-question', { number: q.number })
  }

  return { positions, points }
}

test('plays a full game and records the results', async () => {
  const { host, guest, roomId, h, g } = await setUpRoom()

  g.socket.emit('start-game')
  const refusal = await g.rec.waitFor('error')
  assert.match(refusal.message, /Only the host/)

  // A double-click on Start must not ask Gemini twice.
  const callsBefore = app.geminiCalls()
  h.socket.emit('start-game')
  h.socket.emit('start-game')

  await h.rec.waitFor('game-starting')
  await g.rec.waitFor('new-question', q => q.number === 1)

  const [hostRun, guestRun] = await Promise.all([
    playAll(h, { correct: true }),
    playAll(g, { correct: false })
  ])

  assert.equal(app.geminiCalls() - callsBefore, 1, 'one Gemini call per game')
  assert.equal(hostRun.positions.length, 15)
  assert.equal(guestRun.points, 0)
  assert.ok(new Set(hostRun.positions).size > 1, 'right answer is not always in the same place')

  const over = await h.rec.waitFor('game-over')
  assert.equal(over.scores[host.username], hostRun.points)
  assert.equal(over.scores[guest.username], 0)

  const board = await request(app, 'GET', '/leaderboard', undefined, host.token)
  const entry = board.body.find(r => r._id === host.username)
  assert.deepEqual(
    { totalScore: entry.totalScore, gamesPlayed: entry.gamesPlayed },
    { totalScore: hostRun.points, gamesPlayed: 1 }
  )

  const rooms = await request(app, 'GET', '/rooms', undefined, host.token)
  const room = rooms.body.rooms.find(r => String(r._id) === roomId)
  assert.equal(room.status, 'finished')
  assert.equal(room.playerCount, 2)
  assert.equal('players' in room, false, 'member ids are not sent to the lobby')

  h.socket.close()
  g.socket.close()
})

test('a player whose connection drops carries on after reconnecting', async () => {
  const { roomId, host, h, g } = await setUpRoom()

  h.socket.emit('start-game')
  await g.rec.waitFor('new-question', q => q.number === 1)

  // Cut the connection. The client reconnects and re-joins by itself.
  const mark = g.rec.mark()
  g.socket.io.engine.close()

  const resumed = await g.rec.waitFor('new-question', q => q.number === 1, 5000, mark)
  assert.ok(resumed.timeLeftMs < resumed.durationMs, 'resumes with the time left, not a fresh timer')

  const resultMark = g.rec.mark()
  g.socket.emit('submit-answer', { answer: rightIndex(resumed) })
  const result = await g.rec.waitFor('answer-result', () => true, 5000, resultMark)
  assert.equal(result.correct, true)

  // Everyone leaves. After the grace period the game is finished and
  // the results are saved rather than thrown away.
  h.socket.close()
  g.socket.close()
  await sleep(2500)

  const rooms = await request(app, 'GET', '/rooms', undefined, host.token)
  const room = rooms.body.rooms.find(r => String(r._id) === roomId)
  assert.equal(room.status, 'finished')
})

test('a player who stays away past the grace period is counted as done', async () => {
  const { h, g } = await setUpRoom()

  h.socket.emit('start-game')
  await g.rec.waitFor('new-question', q => q.number === 1)

  g.socket.close()
  const leftAt = Date.now()

  await playAll(h, { correct: true })
  await h.rec.waitFor('game-over', () => true, 5000)

  assert.ok(Date.now() - leftAt >= 1400, 'the game waited for the grace period')
  h.socket.close()
})

test('the host role moves on, and abandoned waiting rooms are removed', async () => {
  const { guest, roomId, h, g } = await setUpRoom()

  h.socket.close()
  await g.rec.waitFor('room-state', s => s.host === guest.username, 4000)

  g.socket.close()
  await sleep(2000)

  const rooms = await request(app, 'GET', '/rooms', undefined, guest.token)
  assert.equal(rooms.body.rooms.some(r => String(r._id) === roomId), false)
})

test('a busy Gemini is retried before the host sees an error', async () => {
  const busy = await startApp(mongo, { FAKE_GEMINI_FAIL_TIMES: '1' })
  try {
    const { h, g } = await setUpRoom(busy)
    h.socket.emit('start-game')
    await h.rec.waitFor('new-question', q => q.number === 1, 15000)
    assert.equal(busy.geminiCalls(), 2)
    h.socket.close()
    g.socket.close()
  } finally {
    await busy.stop()
  }
})

test('when Gemini is down, players are told and the host can try again', async () => {
  const down = await startApp(mongo, { FAKE_GEMINI_FAIL_TIMES: '100' })
  try {
    const { h, g } = await setUpRoom(down)
    h.socket.emit('start-game')

    const failed = await g.rec.waitFor('start-failed', () => true, 20000)
    assert.match(failed.message, /try again/)
    assert.equal(down.geminiCalls(), 3, 'three attempts in total')

    const metrics = await (await fetch(down.metricsUrl)).text()
    assert.match(metrics, /question_generations_total\{outcome="failure"\} 1/)

    h.socket.close()
    g.socket.close()
  } finally {
    await down.stop()
  }
})

test('a deploy (SIGTERM) tells players and exits cleanly', async () => {
  const doomed = await startApp(mongo)
  const { h, g } = await setUpRoom(doomed)

  try {
    h.socket.emit('start-game')
    await g.rec.waitFor('new-question', q => q.number === 1)

    const exited = doomed.stop()
    await g.rec.waitFor('server-restarting', () => true, 3000)
    assert.equal(await exited, 0)
  } finally {
    h.socket.close()
    g.socket.close()
    await doomed.stop()
  }
})
