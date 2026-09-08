const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const User = require('../models/User')

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
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters' })
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    await User.create({ name, email, username, password: hashedPassword })
    res.json({ message: 'Signup Successful', name, email, username })
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
    const user = await User.findOne({ email })

    // Same response and roughly the same work either way, so the endpoint
    // does not tell an attacker whether the email exists.
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const ok = await bcrypt.compare(password, user.password)
    if (!ok) {
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