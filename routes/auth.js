const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const User = require('../models/User')

router.post('/signup', async (req, res) => {
  const { name, email, username, password } = req.body
  const hashedPassword = await bcrypt.hash(password, 10)
  const user = await User.create({ name, email, username, password: hashedPassword })
  res.json({ message: 'Signup Successful', user })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  const user = await User.findOne({ email })
  if (!user) {
    res.json({ message: "User doesn't exist" })
  } else {
    if (await bcrypt.compare(password, user.password)) {
      res.json({ message: 'Login Successful' })
    } else {
      res.json({ message: 'Wrong Password' })
    }
  }
}) 



  
module.exports = router