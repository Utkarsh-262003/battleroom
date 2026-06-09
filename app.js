require('dotenv').config() 
const http = require('http')
const mongoose = require('mongoose')
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('Connection failed:', err))
const express = require('express') 
const jwt = require('jsonwebtoken')
const app = express() 
app.set('trust proxy', 1)
const helmet = require('helmet') 
const gemini = process.env.GEMINI_API_KEY

app.use(helmet())
const Room = require('./models/Room')
const GameResult = require('./models/GameResult')
const rateLimit = require('express-rate-limit')
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000 ,
   max: 100,
  message: "SORRY TOO MANY REQUEST"
})
const limiter2 = rateLimit({
  windowMs: 15 * 60 * 1000 ,
   max: 10,
  message: "SORRY TOO MANY REQUEST"
})
app.use(limiter)

app.use(express.json()) 
app.use(express.static('public'))

  const gameState = {}

  
app.use((req, res, next) => { 
  console.log(`${req.method} ${req.url}`) 
  next() 
}) 



const authRouter   = require('./routes/auth.js') 
const roomRouter   = require('./routes/rooms.js') 
const gameRouter   = require('./routes/game.js') 
const leaderRouter = require('./routes/leaderboard.js') 
  
app.use('/auth',  limiter2,
       authRouter) 
app.use('/rooms',       roomRouter) 
app.use('/game',        gameRouter) 
app.use('/leaderboard', leaderRouter) 

app.get('/', (req, res) => {
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
        state.answered = new Set()
        const question = gameState[roomId].questions[state.currentQuestion]
        const { correctOption, ...safeQuestion } = question 
        io.to(roomId).emit('new-question', safeQuestion)
        state.timer = setTimeout(async()=>{
          console.log("time-up")
          state.currentQuestion++
          if(state.currentQuestion === state.questions.length){
              const room = await Room.findById(roomId)
              Object.entries(state.scores).forEach(([username, score]) => {
                const userId = state.playerIds[username]
                GameResult.create({ username, userId, score, roomName: room.name })
              })
              io.to(roomId).emit('game-over', { scores: state.scores })
              delete gameState[roomId]           
          }
          else{
            sendQuestion(roomId)
          }
        }
        ,15000)

        

}
const { GoogleGenerativeAI } = require('@google/generative-ai')


async function fetchQuestions() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })  
  const prompt = `Generate 5 random general knowledge quiz questions. 
  Return ONLY a JSON array, no markdown, no explanation, just the raw JSON.
  Format:
  [
    {
      "question": "question text",
      "options": ["option1", "option2", "option3", "option4"],
      "correctOption": 0
    }
  ]
  correctOption is the index of the correct answer in the options array.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()
  return JSON.parse(text)
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

        const room = io.sockets.adapter.rooms.get(currentRoom)
        const roomSize = room ? room.size : 0

        if (roomSize === 0 && gameState[currentRoom]) {
            clearTimeout(gameState[currentRoom].timer)
            delete gameState[currentRoom] 
            console.log(`Room ${currentRoom} is empty. Game timer cleared.`)
        }
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
        try{
        gameState[currentRoom] = {
          currentQuestion: 0,
          scores: {},
          timer: null,
          answered: new Set(),
          playerIds: {},
          questions: await fetchQuestions()

        }
      }
      catch(err){
        console.error('Gemini error:', err)
        socket.emit('error', { message: 'Internal server error' })
        return
}
        sendQuestion(currentRoom)
      }
      else{
       socket.emit('error', { message: 'Only the host can start the game' })
      }
    })
     socket.on('submit-answer', ({ answer }) => {
    if (!gameState[currentRoom]) return 
    const state = gameState[currentRoom]
    const username = socket.data.user.username
    state.playerIds[username] = socket.data.user._id

    if (state.answered.has(username)) return  
    state.answered.add(username) 
    const question = gameState[currentRoom].questions[state.currentQuestion]

    if (answer == question.correctOption) {
        state.scores[username] = (state.scores[username] || 0) + 10
        socket.emit('answer-result', { correct: true, scores: state.scores })
    } else {
        socket.emit('answer-result', { correct: false, scores: state.scores })
    }
})
})

server.listen(PORT, ()=>console.log(`Server on port ${PORT}`))