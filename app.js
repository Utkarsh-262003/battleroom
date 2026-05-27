require('dotenv').config() 
const express = require('express')
const app = express()
app.use(express.json())
const authThing = require('./routes/auth.js')
const rooms = require('./routes/rooms.js')
const games = require('./routes/game.js')
const leader = require('./routes/leaderboard.js')




app.use((req, res, next)=>{
    const url = req.url
    const method = req.method
    console.log(`url is :${url} , method is ${method}`)
    next()
})
// routers later when i export them later along app.use later 
app.use('/auth', authThing)
app.use('/rooms', rooms)
app.use('/game', games)
app.use('/leaderboard', leader)


  app.use((req, res)=>{
    res.status(404).json({ error: 'Route not found' })
  })
  app.use((err, req, res, next)=>{
  console.log(err)
  res.status(500).json({ error: 'Internal Server Error' })
})
const PORT = process.env.PORT 
app.listen(PORT) 
