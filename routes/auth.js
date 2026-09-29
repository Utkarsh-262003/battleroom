const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const User = require('../models/User')

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NAME_LENGTH = 50
const MAX_EMAIL_LENGTH = 254

// bcrypt only looks at the first 72 bytes of a password. Anything
// longer would be silently cut, so it is refused instead.
const MAX_PASSWORD_BYTES = 72

// Compared against when the email does not exist, so a failed login
// takes the same time whether or not the account is real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10)

// Every one of these must be a real string. Without this check a JSON body
// like {"email": {"$gt": ""}} reaches Mongoose as a query operator instead
// of a value, which lets an attacker match users they should not be able to.
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

router.post('/signup', async (req, res) => {
  const { name, email, username, password } = req.body || {}

  if (![name, email, username, password].every(isNonEmptyString)) {
    return res.status(400).json({ message: 'All fields are required' })
  }

  const cleanName = name.trim()
  const cleanEmail = email.trim()
  const cleanUsername = username.trim()

  if (cleanName.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` })
  }
  if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(cleanEmail)) {
    return res.status(400).json({ message: 'Enter a valid email address' })
  }
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    return res.status(400).json({
      message: 'Username must be 3 to 20 characters: letters, numbers, dots, dashes or underscores'
    })
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' })
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ message: 'Password is too long' })
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    await User.create({
      name: cleanName,
      email: cleanEmail,
      username: cleanUsername,
      password: hashedPassword
    })
    res.json({ message: 'Signup Successful', name: cleanName, email: cleanEmail, username: cleanUsername })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Duplicate email or username' })
    }
    console.error('signup failed:', err.message)
    res.status(500).json({ message: 'Internal server error' })
  }
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}

  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return res.status(401).json({ message: 'Invalid credentials' })
  }

  try {
    const user = await User.findOne({ email: email.trim() })

    // Same response and the same bcrypt work either way, so the endpoint
    // does not tell an attacker whether the email exists.
    const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH)

    if (!user || !ok) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const { _id, username } = user
    const token = jwt.sign({ _id, username }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token })
  } catch (err) {
    console.error('login failed:', err.message)
    res.status(500).json({ message: 'Internal server error' })
  }
})

module.exports = router
