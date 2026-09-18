# BattleRoom ⚔️

A real-time multiplayer quiz battle game. Players join rooms, race through AI-generated
questions at their own pace, and get ranked on a persistent leaderboard.

**Live demo:** https://battleroom-v8yy.onrender.com

> Free tier on Render spins down when idle, so the first visit can take ~50s to wake up.

For the full reference — data model, socket protocol, game engine internals, deployment
details — see **[PROJECT.md](PROJECT.md)**.

---

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** MongoDB + Mongoose
- **Real-time:** Socket.io
- **Auth:** JWT + bcrypt
- **AI:** Google Gemini API (dynamic question generation)
- **Security:** Helmet, express-rate-limit
- **Packaging:** Docker, Docker Compose, nginx
- **Infrastructure:** Terraform, Ansible, AWS EC2
- **CI:** GitHub Actions → Docker Hub
- **Hosting:** AWS EC2 and Render, MongoDB Atlas

Requires Node.js 20.19 or newer.

---

## Features

- JWT-based authentication (signup / login)
- Create and join game rooms
- 15 AI-generated questions per game, written fresh by Gemini every time
- Topics are randomised per game, so games don't all drift to the same general knowledge
- Real-time question delivery via WebSockets
- **Self-paced play** — everyone gets the same 15 questions, but each player has their own
  position, their own 15-second timer and their own Next button. Nobody waits for anybody
- Live scoreboard that updates for every player in the room whenever anyone answers
- Anti-cheat — one answer per player per question, and the correct answer is never sent
  until after your answer is locked in
- Persistent leaderboard via MongoDB aggregation pipeline
- Room lifecycle — rooms move from `waiting` to `in-progress` to `finished`, so completed
  games leave the lobby
- Automatic cleanup — dead rooms are closed on boot, and only the 5 newest finished rooms
  are kept in the database
- Health endpoint at `/healthz` for uptime checks and container healthchecks

---

## Architecture

```
Client (HTML/CSS/JS)
      ↕ HTTP (REST)         ↕ WebSocket (Socket.io)
            nginx (reverse proxy, port 80)
Express Server (Node.js, port 3000)
      ↕                           ↕
MongoDB Atlas              Gemini API
```

**Request flow:**

1. User authenticates → JWT issued
2. User joins a room over REST → server records them as a player
3. Socket.io connection opens, authenticated with the same JWT
4. Host starts the game → server asks Gemini for 20 questions and keeps the best 15
5. Every connected player in the room is sent question 1 and their own 15s timer starts
6. Answers are validated server-side. A correct answer is 10 points
7. Each player advances alone, by pressing Next or by letting the timer run out
8. When every player has finished all 15, scores are written to MongoDB and the room closes

Game state lives in the server process, keyed by room. A restart ends any game in progress,
and rooms left stranded as `in-progress` are marked `finished` on the next boot.

---

## Security

Identity and authorization:

- JWT verified on every socket connection and on every protected REST route
- The socket takes the username from the verified token, never from the client payload
- Room membership is checked against the database before a socket can join a room's channel
- Only the room host can start a game

Input handling:

- All auth inputs are type-checked as strings before reaching Mongoose, so a JSON body like
  `{"email": {"$gt": ""}}` cannot be interpreted as a query operator
- Room names and IDs are validated for type and length
- Request bodies are capped at 10kb
- The frontend renders all user-supplied text through `textContent`, never by interpolating
  into `innerHTML`, so a room name or username containing HTML is displayed as literal text

Transport and headers:

- Helmet sets CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options` and related headers
- CSP uses `script-src 'self'` and `script-src-attr 'none'`, so inline scripts and inline
  event handlers are blocked
- Frontend JavaScript lives in its own file rather than inline, for CSP compliance
- `upgradeInsecureRequests` is currently disabled, because the AWS deployment is still
  plain HTTP. It goes back on once TLS is in place

Abuse and error handling:

- Global rate limit of 100 requests per 15 minutes per IP
- Stricter limit of 10 requests per 15 minutes on `/auth` routes
- Correct answers are never sent to the client, and answers are validated server-side only
- Anti-cheat via a per-player `answered` flag, so a second submission is ignored
- The Next button is checked against the question number, so a double click cannot skip a
  question
- Nothing Gemini returns is trusted. Every question is shape-checked, and duplicates are
  dropped, before a game uses it
- Error responses are generic; stack traces and driver errors are logged server-side, never
  returned to the client
- The app refuses to start if any required environment variable is missing, and names the
  missing ones

---

## Health check

```bash
curl http://localhost:3000/healthz
```

Returns `200` with `{"status":"ok","db":true}` when the process is up and MongoDB is
connected, and `503` when the database connection is down.

This endpoint is deliberately mounted before the rate limiter, so automated probes are never
throttled. Docker Compose uses it to hold nginx back until the app is actually ready.

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

### With Docker

```bash
docker compose up --build
```

Starts the app plus nginx on port 80. nginx waits for the app's healthcheck to pass before
it comes up.

---

## Deployment

The app is containerised and deployed to AWS with infrastructure and configuration as code.

| Tool | File(s) | Job |
|---|---|---|
| Docker | `Dockerfile` | Builds the app image on Node 22, production deps only, runs as a non-root user |
| Compose | `compose.yaml`, `compose.prod.yaml` | Two containers, app and nginx. The prod file pulls the published image instead of building |
| nginx | `nginx.conf` | Reverse proxy on port 80, with the `Upgrade` headers WebSockets need and `X-Forwarded-For` for correct rate limiting |
| GitHub Actions | `.github/workflows/docker.yml` | On every push to `main`, builds and pushes the image to Docker Hub tagged with both the commit SHA and `latest` |
| Terraform | `terraform/` | VPC, public subnet, internet gateway, routing, security group (22/80/443), a `t3.micro` EC2 instance and an Elastic IP, in `ap-south-1` |
| Ansible | `ansible/` | Installs Docker on the server, copies the prod Compose file, nginx config and `.env`, then runs `docker compose up -d` |

Deploying an update is a push to `main` (CI builds the image) followed by a playbook run
(`pull_policy: always` fetches the new `latest`).

```bash
cd terraform && terraform apply        # provision
cd ../ansible && ansible-playbook playbook.yml   # configure and start
```

The playbook copies `.env` from the project root, so that file has to exist locally on
whoever runs it. It is gitignored and never baked into the image.

---

## Known issues

- **No TLS yet.** Port 443 is open in the security group but nothing serves it. This is why
  the CSP `upgradeInsecureRequests` directive is turned off.
- **In-memory game state.** Scores and question progress live in the process, so a restart
  mid-game loses the round in progress. It also means the app cannot yet be scaled past one
  instance. Moving state to Redis, with a Socket.io adapter, is the fix.
- **No retry when Gemini is unavailable.** The API returns `503` under load. The error is
  caught and surfaced, but the host has to click Start again. Retry with exponential backoff
  is the fix.
- **Only connected sockets are in the game.** Joining a room over REST puts you in the
  database, but if your socket is not connected when the host presses Start, you sit that
  game out.
- **No automated tests.** (`test.html` is the frontend page, not a test suite.)

---

## Roadmap

- TLS, so the site runs on HTTPS
- Jenkins pipeline alongside the existing GitHub Actions build
- Prometheus and Grafana for monitoring
- Redis-backed game state, so the app can run on more than one instance
