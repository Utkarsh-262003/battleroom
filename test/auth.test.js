const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

const { startMongo, startApp, request, makeUser } = require('./support/helpers')

let mongo
let app

before(async () => {
  mongo = await startMongo()
  app = await startApp(mongo)
})

after(async () => {
  if (app) await app.stop()
  if (mongo) await mongo.stop()
})

function signup(fields) {
  return request(app, 'POST', '/auth/signup', {
    name: 'Test Person',
    email: 'someone@example.test',
    username: 'someone',
    password: 'password123',
    ...fields
  })
}

test('signup rejects bad input', async () => {
  for (const username of ['ab', 'has space', '<script>', 'x'.repeat(21)]) {
    const res = await signup({ username })
    assert.equal(res.status, 400, `username "${username}"`)
  }

  assert.equal((await signup({ email: 'not-an-email' })).status, 400)
  assert.equal((await signup({ name: 'n'.repeat(51) })).status, 400)
  assert.equal((await signup({ password: 'short' })).status, 400)
  assert.equal((await signup({ password: 'p'.repeat(73) })).status, 400, 'bcrypt would cut it at 72 bytes')
  assert.equal((await signup({ email: { $gt: '' } })).status, 400)
})

test('login gives the same answer for an unknown email and a wrong password', async () => {
  const user = await makeUser(app, 'login')

  const unknown = await request(app, 'POST', '/auth/login', { email: 'nobody@example.test', password: 'password123' })
  const wrong = await request(app, 'POST', '/auth/login', { email: user.email, password: 'wrong-password' })

  assert.equal(unknown.status, 401)
  assert.deepEqual(unknown.body, wrong.body)
})

test('successful logins do not use up the rate limit', async () => {
  const user = await makeUser(app, 'friendly')

  for (let i = 0; i < 12; i++) {
    const res = await request(app, 'POST', '/auth/login', { email: user.email, password: user.password })
    assert.equal(res.status, 200, `login ${i + 1}`)
  }
})

test('repeated failed logins are rate limited', async () => {
  let last
  for (let i = 0; i < 12; i++) {
    last = await request(app, 'POST', '/auth/login', { email: 'guess@example.test', password: `guess-${i}` })
  }
  assert.equal(last.status, 429)
  assert.match(last.body.message, /Too many attempts/)
})

test('protected routes refuse missing, forged and unsigned tokens', async () => {
  const forged = jwt.sign({ _id: 'x', username: 'mallory' }, 'some-other-secret')
  const unsigned = jwt.sign({ _id: 'x', username: 'mallory' }, null, { algorithm: 'none' })

  for (const token of [undefined, 'garbage', forged, unsigned]) {
    const res = await request(app, 'GET', '/rooms', undefined, token)
    assert.equal(res.status, 401)
  }
})

test('the homepage is served from public/', async () => {
  const res = await fetch(app.base + '/')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<title>BattleRoom<\/title>/)
})
