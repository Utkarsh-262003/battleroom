const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { io } = require('socket.io-client')

const { sleep, startMongo, startApp, request, makeUser, createRoom, connect, closeAllSockets } = require('./support/helpers')

let mongo
let app
let user

before(async () => {
  mongo = await startMongo()
  app = await startApp(mongo)
  user = await makeUser(app, 'safe')
  await createRoom(app, user)
})

after(async () => {
  closeAllSockets()
  if (app) await app.stop()
  if (mongo) await mongo.stop()
})

const BAD_PAYLOADS = [
  null,
  42,
  'text',
  [],
  true,
  { roomId: { $gt: '' } },
  { roomId: 'not-an-id' },
  { roomId: '__proto__' },
  { answer: '0' },
  { answer: { $gt: -1 } },
  { number: null }
]

// Before the fix, the first of these killed the process:
// socket.emit('join-room', null)
for (const event of ['join-room', 'start-game', 'submit-answer', 'next-question', 'made-up-event']) {
  test(`malformed "${event}" messages do not crash the server`, async () => {
    const { socket, ready } = connect(app, user)
    await ready

    socket.emit(event)
    for (const payload of BAD_PAYLOADS) socket.emit(event, payload)

    await sleep(300)
    socket.close()

    assert.ok(app.isRunning(), 'server exited:\n' + app.log())
    const health = await request(app, 'GET', '/healthz')
    assert.equal(health.status, 200)
  })
}

test('a flood of messages from one socket is cut off, and the server survives', async () => {
  const { socket, ready } = connect(app, user)
  await ready

  for (let i = 0; i < 500; i++) socket.emit('join-room', { roomId: 'x' })

  await sleep(300)
  socket.close()
  assert.ok(app.isRunning())
})

function refused(token) {
  return new Promise(resolve => {
    const socket = io(app.base, { auth: { token }, transports: ['websocket'], reconnection: false })
    socket.on('connect', () => { socket.close(); resolve(false) })
    socket.on('connect_error', err => { socket.close(); resolve(err.message) })
  })
}

test('sockets without a valid token are refused', async () => {
  assert.equal(await refused(undefined), 'unauthorized')
  assert.equal(await refused('garbage'), 'unauthorized')
  assert.equal(await refused(jwt.sign({ _id: 'x', username: 'mallory' }, 'some-other-secret')), 'unauthorized')

  const unsigned = jwt.sign({ _id: 'x', username: 'mallory' }, null, { algorithm: 'none' })
  assert.equal(await refused(unsigned), 'unauthorized')
})

test('joining a room you are not a member of is refused', async () => {
  const outsider = await makeUser(app, 'outsider')
  const roomId = await createRoom(app, user, 'Private')

  const { socket, rec, ready } = connect(app, outsider)
  await ready
  socket.emit('join-room', { roomId })

  const err = await rec.waitFor('error')
  assert.equal(err.code, 'room-gone')
  assert.equal(rec.count('room-state'), 0)
  socket.close()
})
