require('dotenv').config() 
const http = require('http')
const mongoose = require('mongoose')
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('Connection failed:', err))
const express = require('express') 
const jwt = require('jsonwebtoken')
const app = express() 
const Room = require('./models/Room')
app.use(express.json()) 
const questions = [ 
  {
  question: "What is the capital of India?",
  options: ["Paris", "London", "New Delhi", "Madrid"],
  correctOption: 2
},
{
  question: "Who is the richest person in the world?",
  options: ["Jeff Bezos", "Elon Musk", "Dario Amodei", "Donald Trump"],
  correctOption: 1
},
{
  question: "Who is the main female protagonist in Solo-Leveling?",
  options: ["Cha Hae-In", "Lee Joo-Hee", "Radiru Esil", "Park Hee-Jin"],
  correctOption: 0
},
{
  question: "How many continents are there in the world?",
  options: ["5", "7", "6", "8"],
  correctOption: 1
},
{
  question: "Which Country has the highest GDP(Nominal)?",
  options: ["Germany", "Japan", "China", "USA"],
  correctOption: 3
}
]
  const gameState = {}

  
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

app.get('/test', (req, res) => {
  res.sendFile(__dirname + '/test.html')
})
  
app.use((req, res) => { 
  res.status(404).json({ error: 'Route not found' }) 
}) 
  
app.use((err, req, res, next) => { 
  console.error(err.stack) 
  res.status(500).json({ error: err.message }) 
}) 
function sendQuestion(roomId){
        const state = gameState[roomId]
        const question = questions[state.currentQuestion]
        const { correctOption, ...safeQuestion } = question 
        io.to(roomId).emit('new-question', safeQuestion)
        state.timer = setTimeout(()=>{
          console.log("time-up")
          state.currentQuestion++
          if(state.currentQuestion === questions.length){
              io.to(roomId).emit('game-over', { scores: state.scores })
              delete gameState[roomId]           
          }
          else{
            sendQuestion(roomId)
          }
        }
        ,15000)

        

}
  
const PORT = process.env.PORT 

const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server)
io.on('connection', (socket) => {
     try {
        const token = socket.handshake.auth.token
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        socket.data.user = decoded
        console.log('socket authenticated:', socket.data.user.username)
    } catch (err) {
        console.log('invalid token, disconnecting')
        socket.disconnect()
        return
    }

    console.log('a user connected:', socket.id)
    let currentRoom = null  // outer scope — both handlers can see this

    socket.on('join-room', ({ roomId, username }) => {
        currentRoom = roomId  // set it when player joins
        socket.join(currentRoom)
        io.to(currentRoom).emit('player-joined', { username })
    })

    socket.on('disconnect', () => {
        if (currentRoom) {
            io.to(currentRoom).emit('player-left', { socketId: socket.id })
            console.log(`user disconnected from ${currentRoom}:`, socket.id)
        }
    })
    socket.on('start-game', async()=>{
      const pusher = socket.data.user._id
      let room
      try{
       room = await Room.findById(currentRoom)
      }
      catch(err){
        socket.emit('error', { message: 'Internal server error' })
          return    
          }
      const host = room.host
      if (pusher === host.toString()) {
        gameState[currentRoom] = {
          currentQuestion: 0,
          scores: {},
          timer: null
        }
        sendQuestion(currentRoom)
      }
      else{
       socket.emit('error', { message: 'Only the host can start the game' })
      }
    })
     socket.on('submit-answer', ({ answer }) => {
      const state = gameState[currentRoom]
      const question = questions[state.currentQuestion]
      const username = socket.data.user.username
      if(answer ==question.correctOption){
        state.scores[username] = (state.scores[username] || 0) + 10
        socket.emit('answer-result', {correct: true, scores: state.scores })

      }
      else {
        socket.emit('answer-result', { correct: false, scores: state.scores })
          }
    })
})

server.listen(PORT, ()=>console.log(`Server on port ${PORT}`))