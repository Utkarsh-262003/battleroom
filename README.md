BattleRoom ⚔️
A real-time multiplayer quiz battle game. Players join rooms, compete live on AI-generated questions, and get ranked on a leaderboard.
Live demo: https://battleroom-v8yy.onrender.com

Free tier on Render may take ~50s to wake up on first visit.

Tech Stack

Backend: Node.js, Express.js
Database: MongoDB + Mongoose
Real-time: Socket.io
Auth: JWT + bcrypt
AI: Google Gemini API (dynamic question generation)
Security: Helmet, express-rate-limit
Hosting: Render, MongoDB Atlas

Features

JWT-based authentication (signup / login)
Create and join game rooms
AI-generated quiz questions on every game via Gemini API
Real-time question delivery via WebSockets
Anti-cheat — one answer per player per question
Live scoreboard during gameplay
Persistent leaderboard via MongoDB aggregation pipeline
Rate limiting — global (100 req/15min) + strict auth routes (10 req/15min)
Helmet security headers — CSP, X-Powered-By removal, and more
Separated frontend JS for CSP compliance

Architecture
Client (HTML/CSS/JS)
      ↕ HTTP (REST)         ↕ WebSocket (Socket.io)
Express Server (Node.js)
      ↕                           ↕
MongoDB Atlas              Gemini API
Request flow:

User authenticates → JWT issued
User joins room → Socket.io connection established with JWT auth
Host starts game → server fetches 5 questions from Gemini API
Questions delivered in real-time → answers validated server-side
Scores tracked in memory → persisted to MongoDB on game end

Security

Helmet sets secure HTTP response headers
Rate limiter blocks brute force on /auth routes (10 req/15min)
Global rate limiter prevents API abuse (100 req/15min)
JWT verified on every socket connection
Correct answers never sent to client — validated server-side only
Anti-cheat: Set-based deduplication prevents multiple submissions

Run Locally
bashgit clone https://github.com/Utkarsh-262003/battleroom.git
cd battleroom
npm install
Create a .env file:
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_gemini_api_key
PORT=3000
bashnpm start
Docker
bashdocker build -t battleroom .
docker run -p 3000:3000 --env-file .env battleroom