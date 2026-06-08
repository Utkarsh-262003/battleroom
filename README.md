# BattleRoom ⚔️

A real-time multiplayer quiz battle game. Players join rooms, compete live, and get ranked on a leaderboard.

**Live demo:** https://battleroom-v8yy.onrender.com

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** MongoDB + Mongoose
- **Real-time:** Socket.io
- **Auth:** JWT + bcrypt
- **Security:** Helmet, express-rate-limit
- **Hosting:** Render (backend + frontend), MongoDB Atlas

## Features

- JWT-based authentication (signup/login)
- Create and join game rooms
- Real-time question delivery via WebSockets
- Anti-cheat — one answer per player per question
- Persistent leaderboard via MongoDB aggregation
- Rate limiting on auth routes

## Run Locally

```bash
git clone https://github.com/Utkarsh-262003/battleroom.git
cd battleroom
npm install
# create .env with MONGO_URI, JWT_SECRET, PORT
npm run dev
```

> Free tier on Render may take ~50s to wake up on first visit.