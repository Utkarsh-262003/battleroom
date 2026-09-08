# BattleRoom ⚔️

A real-time multiplayer quiz battle game. Players join rooms, compete live on AI-generated questions, and get ranked on a leaderboard.

**Live demo:** https://battleroom-v8yy.onrender.com

> Free tier on Render spins down when idle, so the first visit can take ~50s to wake up.

---

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** MongoDB + Mongoose
- **Real-time:** Socket.io
- **Auth:** JWT + bcrypt
- **AI:** Google Gemini API (dynamic question generation)
- **Security:** Helmet, express-rate-limit
- **Hosting:** Render, MongoDB Atlas

Requires Node.js 20.19 or newer.

---

## Features

- JWT-based authentication (signup / login)
- Create and join game rooms
- AI-generated quiz questions on every game via Gemini API
- Real-time question delivery via WebSockets
- Anti-cheat — one answer per player per question
- Live scoreboard during gameplay
- Persistent leaderboard via MongoDB aggregation pipeline
- Room lifecycle — rooms move from `waiting` to `in-progress` to `finished`, so completed games leave the lobby
- Health endpoint at `/healthz` for uptime checks and container healthchecks

---

## Architecture

```
Client (HTML/CSS/JS)
      ↕ HTTP (REST)         ↕ WebSocket (Socket.io)
Express Server (Node.js)
      ↕                           ↕
MongoDB Atlas              Gemini API
```

**Request flow:**

1. User authenticates → JWT issued
2. User joins a room over REST → server records them as a player
3. Socket.io connection opens, authenticated with the same JWT
4. Host starts the game → server fetches 5 questions from Gemini
5. Questions are delivered in real time, answers validated server-side
6. Scores are tracked in memory, then written to MongoDB when the game ends

---

## Security

Identity and authorization:

- JWT verified on every socket connection and on every protected REST route
- The socket takes the username from the verified token, never from the client payload
- Room membership is checked against the database before a socket can join a room's channel
- Only the room host can start a game

Input handling:

- All auth inputs are type-checked as strings before reaching Mongoose, so a JSON body like `{"email": {"$gt": ""}}` cannot be interpreted as a query operator
- Room names and IDs are validated for type and length
- The frontend renders all user-supplied text through `textContent`, never by interpolating into `innerHTML`, so a room name or username containing HTML is displayed as literal text

Transport and headers:

- Helmet sets CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options` and related headers
- CSP uses `script-src 'self'` and `script-src-attr 'none'`, so inline scripts and inline event handlers are blocked
- Frontend JavaScript lives in its own file rather than inline, for CSP compliance

Abuse and error handling:

- Global rate limit of 100 requests per 15 minutes per IP
- Stricter limit of 10 requests per 15 minutes on `/auth` routes
- Correct answers are never sent to the client, and answers are validated server-side only
- Anti-cheat via a per-question `Set`, so a player's second submission is ignored
- Error responses are generic; stack traces and driver errors are logged server-side, never returned to the client
- The app refuses to start if any required environment variable is missing, and names the missing ones

---

## Health check

```bash
curl https://battleroom-v8yy.onrender.com/healthz
```

Returns `200` with `{"status":"ok","db":true}` when the process is up and MongoDB is connected, and `503` when the database connection is down.

This endpoint is deliberately mounted before the rate limiter, so automated probes are never throttled.

---

## Run Locally

```bash
git clone https://github.com/Utkarsh-262003/battleroom.git
cd battleroom
npm install
```

Create a `.env` file in the project root:

```
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_gemini_api_key
PORT=3000
```

All four are required. If any is missing the app exits at startup and prints which ones.

```bash
npm start        # production
npm run dev      # nodemon, auto-restart on change
```

---

## Known issues

- **Scoreboard only updates for the player who answered.** The `answer-result` event is emitted to the answering socket rather than broadcast to the room, so other players see stale scores until their own next answer.
- **No retry when Gemini is unavailable.** The API returns `503` under load. The error is caught and surfaced, but the host has to click Start again. Retry with exponential backoff is the fix.
- **In-memory game state.** Scores and question progress live in the process, so a restart mid-game loses the round in progress.

---

## Roadmap

Currently being redeployed to AWS as a DevOps project: Terraform for the infrastructure, Ansible for configuration, Docker for packaging, Jenkins for the pipeline, and Prometheus with Grafana for monitoring. This README will be updated once that deployment is live.