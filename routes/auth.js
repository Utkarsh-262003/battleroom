const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const User = require('../models/User')
const jwt = require('jsonwebtoken')
const secret = process.env.JWT_SECRET


router.post('/signup', async (req, res) => {
  const { name, email, username, password } = req.body
  const hashedPassword = await bcrypt.hash(password, 10)
   try {
   const user = await User.create({ name, email, username, password: hashedPassword }) 
    res.json({ message: 'Signup Successful',name, email, username })

}
    catch (err) {  
      res.status(409).json({ message: 'Duplicate email or username' })
    }
  
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  const user = await User.findOne({ email })

  if (!user) {
    res.status(401).json({ message: 'Invalid credentials' })
  } else {
        const {_id, username} = user
    if (await bcrypt.compare(password, user.password)) {
        res.json({ token: jwt.sign({ _id, username }, secret, { expiresIn: '7d' }) })    
      } 
        else {
      res.status(401).json({ message: 'Invalid credentials' })
    }
  }
}) 



  
module.exports = router