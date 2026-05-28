require('dotenv').config() 
const mongoose = require('mongoose')
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('Connection failed:', err))
const express = require('express') 
const app = express() 
app.use(express.json()) 
  
app.use((req, res, next) => { 
  console.log(`${req.method} ${req.url}`) 
  next() 
}) 
  
const authRouter   = require('./routes/auth.js') 
const roomRouter   = require('./routes/rooms.js') 
const gameRouter   = require('./routes/game.js') 
const leaderRouter = require('./routes/leaderboard.js') 
  
app.use('/auth',        authRouter) 
app.use('/rooms',       roomRouter) 
app.use('/game',        gameRouter) 
app.use('/leaderboard', leaderRouter) 
  
app.use((req, res) => { 
  res.status(404).json({ error: 'Route not found' }) 
}) 
  
app.use((err, req, res, next) => { 
  console.error(err.stack) 
  res.status(500).json({ error: err.message }) 
}) 
  
const PORT = process.env.PORT 
app.listen(PORT, () => console.log(`Server on port ${PORT}`)) 