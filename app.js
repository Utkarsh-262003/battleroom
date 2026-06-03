require('dotenv').config() 
const http = require('http')
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
  
const PORT = process.env.PORT 

const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server)
io.on('connection', (socket) => {  //in simpole terms each new connection gets its own pipe we are naming that pipe socket
    console.log('a user connected:', socket.id) //that pipe gets a unique id

    socket.on('join-room', ({ roomId, username }) => { //when a pipe connects like it join a room then , we have roomId and username as input , roomid in which room the socket is joining and username of that guy

        socket.join(roomId) //the socket meaning that connection has now joined the room and like from now on all events apply on this person too
        console.log(`${username} joined room ${roomId}`) //just a console statement
        io.to(roomId).emit('player-joined', { username }) //everyone else gets a message that is player has joined
    })
})
server.listen(PORT, ()=>console.log(`Server on port ${PORT}`))