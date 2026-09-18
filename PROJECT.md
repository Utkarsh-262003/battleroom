# BattleRoom — Project Master Document

A single reference for what this project is, how it works, and how it runs.
Written to be readable months from now, by someone who has forgotten the details.

Last reviewed against commit `3f2b496`.

---

## 1. What this is, in plain words

BattleRoom is a multiplayer quiz game you play in a web browser.

You sign up, you land in a lobby, and you either create a room or join one that someone
else made. When enough people are in a room, the person who made the room presses Start.
The server then asks Google's Gemini AI to invent 15 fresh quiz questions on the spot.
Those questions are pushed to every player's browser over a live connection. You pick an
answer, you get 10 points if you are right, and a scoreboard updates for everyone in the
room as people answer. When everybody has finished all 15 questions, the game ends, the
scores are saved to the database, and they count toward a permanent leaderboard.

Three things make it more than a static quiz page:

1. **The questions are generated fresh every game.** Nothing is stored in a question bank.
   Two games never get the same set.
2. **It is live.** The server pushes questions and score changes to browsers instead of the
   browser asking "anything new?" over and over.
3. **The server is the referee.** The browser never learns the correct answer until after
   the player has committed to a choice, and the browser cannot tell the server who it is.
   Both of those are enforced server-side.

The project doubles as a DevOps exercise. The application code is one half. The other half
is the Docker, Terraform, Ansible, nginx and GitHub Actions setup that packages it and puts
it on an AWS server.

---

## 2. The stack, and why each piece is there

| Piece | What it is | Why it's here |
|---|---|---|
| Node.js + Express | The web server | Serves the page, handles login and room REST calls |
| Socket.io | Live two-way connection | Pushes questions and scores without the browser polling |
| MongoDB + Mongoose | The database | Stores users, rooms, and finished game results |
| Google Gemini | The AI model | Writes the quiz questions at game start |
| JWT + bcrypt | Login | bcrypt hashes passwords, JWT proves who you are on later requests |
| Helmet + express-rate-limit | Hardening | Sets security headers, caps how often one IP can call the API |
| Docker + Compose | Packaging | Ships the app and nginx as containers |
| nginx | Reverse proxy | Sits in front on port 80 and forwards to the app, including WebSocket upgrades |
| Terraform | Infrastructure as code | Creates the AWS network and server |
| Ansible | Configuration as code | Installs Docker on that server and starts the app |
| GitHub Actions | CI | Builds the Docker image and pushes it to Docker Hub on every push to `main` |

Node.js 20.19 or newer is required. The Docker image uses Node 22.

---

## 3. The file map

```
app.js                  The whole server: config, DB, Express wiring, game engine, sockets
test.html               The entire frontend page (HTML + CSS), served at /
public/app.js           The entire frontend JavaScript, served as a separate file
models/User.js          Mongoose schema: a user account
models/Room.js          Mongoose schema: a game room
models/GameResult.js    Mongoose schema: one player's score in one finished game
middleware/auth.js      Checks the "Authorization: Bearer <token>" header on REST routes
routes/auth.js          POST /auth/signup, POST /auth/login
routes/rooms.js         GET /rooms, POST /rooms/create, POST /rooms/:roomId/join
routes/leaderboard.js   GET /leaderboard
Dockerfile              Builds the app image
compose.yaml            Local run: builds the image from source, plus nginx
compose.prod.yaml       Server run: pulls the published image from Docker Hub, plus nginx
nginx.conf              Reverse proxy config, with WebSocket upgrade headers
.github/workflows/      CI: build and push the Docker image on push to main
terraform/              AWS network and EC2 server definition
ansible/                Installs Docker on the server and starts the app there
README.md               Public-facing readme
```

Two naming oddities worth remembering:

- **`test.html` is not a test.** It is the real and only frontend page. The name is left over
  from when it genuinely was a scratch file. `app.js` at the root serves it at `/`.
- **There are two files called `app.js`.** The one at the root is the server. The one in
  `public/` is the browser code. They share a name and nothing else.

---

## 4. The data

Three collections in MongoDB. All of them are small and flat.

### User (`models/User.js`)

| Field | Type | Notes |
|---|---|---|
| name | String | Display name, required |
| email | String | Required, unique |
| username | String | Required, unique |
| password | String | The bcrypt hash, never the plain password |

### Room (`models/Room.js`)

| Field | Type | Notes |
|---|---|---|
| name | String | What the host called it |
| host | ObjectId → User | Only this user can start the game |
| players | [ObjectId → User] | Everyone who joined over REST |
| status | String | One of `waiting`, `in-progress`, `finished`. Starts as `waiting` |
| questionSetReference | ObjectId | Declared but unused. A leftover from an earlier design |

### GameResult (`models/GameResult.js`)

| Field | Type | Notes |
|---|---|---|
| username | String | Copied in, so the leaderboard needs no join |
| userId | ObjectId → User | The real link back to the account |
| score | Number | Final score for that one game |
| roomName | String | Copied in, because the room may be deleted later |
| createdAt / updatedAt | Date | Added automatically by `timestamps: true` |

One row is written per player per finished game. The leaderboard is built by summing these.

**Why usernames and room names are copied into GameResult:** the room record gets pruned
after a while (see section 8), and copying the text means a deleted room does not leave a
blank on the leaderboard.

---

## 5. The HTTP API

Everything returns JSON. Routes marked "Auth" need an `Authorization: Bearer <token>` header.

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/` | no | Serves `test.html`, the whole app UI |
| GET | `/healthz` | no | `200 {"status":"ok","db":true}` when Mongo is connected, `503` when not |
| POST | `/auth/signup` | no | Creates an account. Requires name, email, username, password (8+ chars) |
| POST | `/auth/login` | no | Returns `{ token }`, a JWT valid for 7 days |
| GET | `/rooms` | yes | The 50 newest rooms |
| POST | `/rooms/create` | yes | Creates a room. Name must be a string, 1 to 60 characters |
| POST | `/rooms/:roomId/join` | yes | Adds you to a room's player list. Only works while `status` is `waiting` |
| GET | `/leaderboard` | yes | Total score per username, highest first |

Two details that are easy to forget:

- **`/healthz` is registered before the rate limiter on purpose.** Uptime probes and Docker
  healthchecks hit it constantly, and they must never be throttled.
- **The leaderboard is a MongoDB aggregation**, not a loop in JavaScript. It groups
  GameResult rows by username, sums `score`, and sorts descending. The database does the work.

### Rate limits

| Scope | Limit |
|---|---|
| Everything (after `/healthz`) | 100 requests per 15 minutes per IP |
| `/auth/*` | 10 requests per 15 minutes per IP, on top of the global limit |

`app.set('trust proxy', 1)` tells Express to read the real client IP from the
`X-Forwarded-For` header that nginx sets. Without it every request would look like it came
from nginx, and one person hitting the limit would lock out everybody.

---

## 6. The live connection

Socket.io opens one long-lived connection per player. The JWT is sent in the handshake, not
in a later message, so an unauthenticated socket is disconnected immediately on connect.

### Browser sends to server

| Event | Payload | What happens |
|---|---|---|
| `join-room` | `{ roomId }` | Server checks the DB that you really are in that room's player list, then subscribes your socket to that room's channel |
| `start-game` | none | Only the host may do this. Fetches questions from Gemini and starts the game |
| `submit-answer` | `{ answer }` | `answer` is the index 0–3 of the option you clicked |
| `next-question` | `{ number }` | Moves only you to your next question |

### Server sends to browser

| Event | Payload | Meaning |
|---|---|---|
| `player-joined` | `{ username }` | Someone entered the room |
| `player-left` | `{ socketId }` | Someone's connection dropped |
| `new-question` | `{ question, options, number, total }` | Your next question. The correct answer is stripped out |
| `answer-result` | `{ correct, correctOption, scores }` | Sent only to you, only after your answer is locked in |
| `scores-update` | `{ scores }` | Broadcast to everyone whenever anyone answers |
| `player-finished` | `{ scores }` | You finished all 15. Others are still playing |
| `game-over` | `{ scores }` | Everyone finished. Final scores |
| `error` | `{ message }` | Something went wrong, in generic wording |

**The important asymmetry:** `answer-result` carries the correct answer and goes to one
socket. `scores-update` carries no answers and goes to the whole room. That split is what
keeps the correct answer from leaking to players who have not answered yet.

---

## 7. How a game actually runs

This is the part worth understanding properly, because it is the least obvious design
decision in the project.

### Everyone plays the same questions at their own speed

All players in a game get the same 15 questions in the same order. That is the only thing
they share. Each player has their own position in the list, their own 15-second timer, and
their own score. Nobody waits for anybody else between questions.

So a fast player might be on question 9 while a slow player is on question 3. Both see the
same live scoreboard, because scores are broadcast as they change.

The alternative would have been a lockstep design, where the whole room advances together
and the slowest player sets the pace. Self-paced was chosen instead, and that is why the
state is stored per player rather than per room.

### The in-memory state

The server keeps a plain JavaScript object:

```js
gameState[roomId] = {
  questions: [...],        // the 15 questions, correct answers included
  finishing: false,        // guard so the game can only end once
  players: {
    [username]: {
      userId,              // for writing the GameResult row later
      socketId,            // where to send this player's question
      index,               // which question they're on, 0-based
      score,               // 10 points per correct answer
      answered,            // have they answered the current question yet
      done,                // have they finished all 15
      timer                // their personal 15s setTimeout handle
    }
  }
}
```

**This lives in the process, not the database.** Restart the server and every game in
progress is gone. That is a deliberate trade-off for simplicity, and section 13 covers what
it costs.

### The sequence, start to finish

1. The host clicks Start. The server checks that this socket's user really is the room's
   `host`, and that no game is already running for that room.
2. The server calls Gemini and waits. This is the slowest step, usually a few seconds.
3. The server checks again that no game started while it was waiting. This catches a host
   who clicked Start twice.
4. Everyone currently connected to that room's socket channel becomes a player. Anyone who
   joined the room in the database but is not connected right now is not in the game.
5. The room's `status` flips to `in-progress` in the database, which removes it from the
   joinable lobby.
6. Each player is sent question 1 and their own 15-second timer starts.
7. A player answers. The score updates, `answer-result` goes to them alone, and
   `scores-update` goes to the whole room. A Next button appears.
8. The player clicks Next, or their 15 seconds run out. Either way only that player moves
   on. The timer restarts for their new question.
9. When a player's index passes the last question they are marked `done` and get
   `player-finished`. They sit and watch the scoreboard.
10. When every player is `done`, the game ends: one GameResult row is written per player,
    the room's `status` becomes `finished`, `game-over` is broadcast, and the in-memory
    state is deleted.

### The anti-cheat and anti-double-click guards

These are small but each one blocks a real problem:

- **One answer per question.** The `answered` flag is set to true before the answer is even
  scored. A second `submit-answer` for the same question is dropped.
- **The correct answer never ships early.** `sendQuestionTo` destructures `correctOption`
  off the question and sends only the rest. There is nothing in the browser's copy of the
  question to read.
- **Next is checked against the question number.** The client sends which question it thinks
  it is on. If that does not match the server's record, the click is ignored. This stops a
  double-click from skipping a question.
- **The username comes from the token.** The browser never sends its own username on any
  socket event. The server reads it off the verified JWT.
- **Room membership is checked against the database** before a socket may subscribe to a
  room channel. Knowing a room ID is not enough to listen in.
- **`finishing` guards the ending.** Without it, two players finishing at nearly the same
  moment could both trigger the end-of-game write and produce duplicate GameResult rows.

### When people disconnect

- **Everyone leaves mid-game:** all timers are cleared, the in-memory state is deleted, and
  the room is marked `finished` in the database. Without this last step the room would sit
  in the lobby as `in-progress` forever.
- **One player leaves, others remain:** that player's timer stops and they are marked `done`.
  The game can still reach its end for everyone else. Their score is still written.

### On server boot

Two cleanups run as soon as MongoDB connects:

1. Any room still marked `in-progress` is marked `finished`. Game state is in memory, so a
   room that was mid-game before the restart is dead by definition.
2. `pruneFinishedRooms()` runs. See the next section.

---

## 8. Room pruning

Only the 5 newest `finished` rooms are kept in the database. Older ones are deleted.
`waiting` and `in-progress` rooms are never touched.

Sorting is by `_id`, which works because a MongoDB ObjectId begins with its creation
timestamp. Sorting by `_id` descending is the same as sorting newest-first, with no extra
`createdAt` field needed.

Pruning runs at boot, after a game ends, and after an abandoned room is closed. The
post-game call is deliberately fired after `game-over` has already been sent, so a failure
during cleanup can never break the end of somebody's game.

The frontend separately shows only the 5 newest rooms in the lobby, even though the API
returns up to 50.

---

## 9. Where the questions come from

`fetchQuestions()` in `app.js` is the whole of it.

**Topic randomisation.** There is a list of 22 topics in the file: world geography, space,
Indian history, chemistry, video games and so on. Each game shuffles that list and picks 5.
Without this, every game drifted toward the same generic general-knowledge questions.

**Over-asking.** The game needs 15 questions, so the server asks for 20. Some come back
malformed or duplicated, and the spares absorb that.

**Model settings.** `gemini-2.5-flash`, with `responseMimeType: 'application/json'` so the
model returns JSON rather than prose, and `temperature: 1.0` for variety between games.
A timestamp is appended to the prompt as a random seed, for the same reason.

**Nothing from the model is trusted.** The response goes through four filters in order:

1. Markdown fences are stripped, in case the model wrapped its JSON in a code block anyway.
2. `JSON.parse` in a try/catch. Unparseable output raises a clean error.
3. `isValidQuestion` checks the shape of every entry: the question is a string, there are
   exactly 4 options, every option is a string, and `correctOption` is a whole number
   between 0 and 3. Anything failing this is dropped silently.
4. Duplicates are removed. Question text is lowercased and stripped of punctuation first,
   so "What is X?" and "what is x" count as the same question.

If fewer than 15 survive, the game runs with what is left and a warning is logged. If zero
survive, the start fails with an error the host can see.

---

## 10. Security, and the reasoning behind each choice

Each of these exists because of a specific attack. Knowing the attack is what makes the
defence memorable.

### Who you are

- Passwords are hashed with bcrypt at cost 10. The plain password is never stored.
- Login returns the same "Invalid credentials" message and does roughly the same amount of
  work whether the email exists or not. A different message or a much faster response would
  tell an attacker which emails are registered.
- The JWT contains only `_id` and `username`, and expires after 7 days.
- The JWT is verified on every protected REST route and on every socket connection.
- Only the room host can start a game, checked against the database, not against anything
  the client claims.

### What you can send

- **Query operator injection.** Mongoose will happily accept an object where it expects a
  string. A login body of `{"email": {"$gt": ""}}` would otherwise become a query meaning
  "any email at all". Every auth field is therefore type-checked as a real non-empty string
  before it reaches Mongoose. Room names and room IDs get the same treatment, with
  `mongoose.isValidObjectId` for IDs and a 60-character cap for names.
- **Request bodies are capped at 10kb.**

### What gets rendered

- **Stored XSS.** A room name like `<img src=x onerror=...>` would run as code if the
  frontend built HTML strings out of it. Nothing in `public/app.js` uses `innerHTML`. The
  `el()` helper creates elements and sets `textContent`, so user text is always displayed as
  literal text.
- **Content Security Policy.** Helmet sets `script-src 'self'` and `script-src-attr 'none'`,
  which blocks inline scripts and inline `onclick` handlers entirely. That is the reason all
  the frontend JavaScript lives in `public/app.js` and all buttons are wired up with
  `addEventListener`. It is also why the two dynamic lists, room cards and answer options,
  use event delegation on a parent element.
- `upgradeInsecureRequests` is currently disabled in the CSP, because the AWS deployment is
  still plain HTTP. Turn it back on once TLS is in place.

### What comes back out

- Error responses are always generic. Stack traces, Mongo driver errors and file paths are
  logged on the server and never sent to the client.
- The correct answer is stripped from every question before it is sent.

### Startup

The server refuses to boot if `MONGO_URI`, `JWT_SECRET`, `GEMINI_API_KEY` or `PORT` is
missing, and prints exactly which ones are absent. Failing loudly at boot beats failing
mysteriously at runtime.

---

## 11. Deployment

There are three ways this project has run. They are worth keeping straight.

### A. Local, plain Node

```bash
npm install
npm start          # or: npm run dev, for auto-restart via nodemon
```

Needs a `.env` file. Talks to MongoDB Atlas over the network. No Docker, no nginx.

### B. Local, Docker Compose

```bash
docker compose up --build
```

`compose.yaml` builds the app image from the local source and starts two containers:

- **app** — the Node server on port 3000, not exposed to the host directly.
- **nginx** — listens on port 80 and proxies everything to `app:3000`.

nginx waits for the app container to report healthy before it starts, using
`depends_on: condition: service_healthy`. The healthcheck is a small inline Node script that
requests `/healthz` and exits 0 only on a 200.

`nginx.conf` carries the headers that matter for this app:

- `proxy_http_version 1.1` plus the `Upgrade` and `Connection` headers. WebSockets do not
  work without these. Socket.io would silently fall back to slow HTTP polling.
- `X-Forwarded-For` and `X-Real-IP`, which is what makes `trust proxy` in Express work.
- `proxy_read_timeout 300s`, so an idle WebSocket is not cut off.

### C. AWS, the DevOps path

Four tools, each doing one job.

**Terraform** (`terraform/`) builds the infrastructure in `ap-south-1` (Mumbai):

- A VPC on `10.0.0.0/16`
- A public subnet on `10.0.1.0/24` in `ap-south-1a`
- An internet gateway, a route table sending `0.0.0.0/0` to it, and the association joining
  the two to the subnet
- A security group allowing inbound 22 (SSH), 80 (HTTP) and 443 (HTTPS), and all outbound
- A `t3.micro` EC2 instance using the `battleroom-key` key pair
- An Elastic IP attached to that instance, so the address survives a reboot

`terraform output public_ip` prints the address.

**GitHub Actions** (`.github/workflows/docker.yml`) runs on every push to `main`. It logs in
to Docker Hub and builds and pushes the image with two tags: the full commit SHA, and
`latest`. The SHA tag means any specific build can be pulled back later.

**Ansible** (`ansible/`) configures the server:

1. Installs `docker.io` and `docker-compose-v2`
2. Makes sure Docker is running and enabled at boot
3. Creates `/opt/battleroom`
4. Copies `compose.prod.yaml` there as `compose.yaml`, plus `nginx.conf`, plus `.env` with
   permissions `0600`
5. Runs `docker compose up -d`

The target host is in `ansible/inventory.ini`. Deploying again is the same playbook run,
because `compose.prod.yaml` sets `pull_policy: always` and pulls the newest `latest` image.

**The Dockerfile** is small and has two choices worth noting. `npm ci --omit=dev` installs
exactly what `package-lock.json` pins and skips nodemon. `USER node` means the process does
not run as root inside the container.

`.dockerignore` keeps `node_modules`, `.env`, `.git`, the terraform and ansible directories,
`*.pem` and Terraform state out of the image. Secrets are the point of most of that list.

### D. Render (the older hosted demo)

`https://battleroom-v8yy.onrender.com`, on the free tier, which sleeps when idle and takes
around 50 seconds to wake. The AWS path above is the newer work.

---

## 12. Configuration

A `.env` file in the project root. All four are mandatory.

| Variable | What it is |
|---|---|
| `MONGO_URI` | The MongoDB Atlas connection string |
| `JWT_SECRET` | The signing key for tokens. Anyone with this can forge a login |
| `GEMINI_API_KEY` | Google Gemini API key |
| `PORT` | The port the Node server listens on. 3000 everywhere here |

Never committed. `.gitignore` excludes `.env`, `*.pem`, `node_modules/`, `.terraform/` and
Terraform state files.

Tuning constants live at the top of `app.js`, not in the environment:

| Constant | Value | Meaning |
|---|---|---|
| `QUESTION_MS` | 15000 | Seconds per question, in milliseconds |
| `QUESTION_COUNT` | 15 | Questions per game |
| `QUESTION_EXTRA` | 5 | Spares requested from Gemini on top of that |
| `MAX_FINISHED_ROOMS` | 5 | Finished rooms kept in the database |
| `TOPICS_PER_GAME` | 5 | Topics drawn from the list of 22 each game |
| `MAX_LOBBY_ROOMS` | 5 | Rooms shown in the lobby, set in `public/app.js` |

---

## 13. Known limits

These are real and known, not bugs waiting to be discovered.

- **Game state is in memory.** A server restart or crash loses every game in progress. The
  boot cleanup marks those rooms `finished` so the lobby stays tidy, but the round itself is
  gone and no scores are saved for it.
- **This cannot run on more than one server.** `gameState` is a variable in one process. Two
  instances behind a load balancer would each hold half a game. Fixing this means moving
  state to Redis and adding a Socket.io adapter.
- **No retry when Gemini fails.** Gemini returns 503 under load. The error is caught and
  shown, but the host has to click Start again. Retry with exponential backoff is the fix.
- **Only connected sockets are in the game.** Joining a room over REST puts you in the
  database. If your socket is not connected when the host presses Start, you are not in that
  game.
- **No TLS on the AWS deployment yet.** Port 443 is open in the security group but nothing
  serves it. The CSP `upgradeInsecureRequests` directive is disabled for this reason.
- **The Ansible playbook copies `.env` from the repo root.** That file is gitignored, so it
  must exist locally on whoever runs the playbook.
- **`questionSetReference` on the Room schema is unused.** Dead field from an earlier design.
- **There are no automated tests.** `test.html` is a page, not a test suite.

---

## 14. Places the README has drifted

Worth knowing, because the README is the first thing anyone reads.

- It says **5 questions per game**. The code says 15 (`QUESTION_COUNT`).
- It lists **"scoreboard only updates for the player who answered"** as a known issue. That
  has been fixed. `submit-answer` now broadcasts `scores-update` to the whole room.
- It does not mention **self-paced play** or the **Next button**, which is the single most
  significant behaviour in the game.
- It does not mention **room pruning**, the **topic randomisation**, or the **AWS deployment
  being live**. The roadmap section still describes that work as upcoming.

---

## 15. Glossary

Short definitions for the terms used above.

- **JWT** — a signed token the server hands you at login. You send it back on later
  requests. The signature proves it was not tampered with, so the server does not need to
  store sessions.
- **bcrypt** — a deliberately slow password hashing function. Slowness is the feature; it
  makes guessing passwords in bulk expensive.
- **WebSocket** — a connection that stays open so both sides can send messages at any time.
  Ordinary HTTP only lets the browser ask and the server answer.
- **Socket.io** — a library on top of WebSockets adding rooms, reconnection, and a fallback
  when WebSockets are blocked.
- **CSP (Content Security Policy)** — a header telling the browser which scripts it is
  allowed to run. It turns an injected script into a blocked script.
- **XSS** — getting your own JavaScript to run inside someone else's page, usually by
  putting HTML into a field like a username and having the site render it as markup.
- **Reverse proxy** — a server in front of your app that receives requests and passes them
  on. nginx does this here, and handles the WebSocket upgrade.
- **Aggregation pipeline** — MongoDB's way of grouping, summing and sorting inside the
  database instead of in application code.
- **ObjectId** — MongoDB's ID type. Its first bytes are a creation timestamp, which is why
  sorting by `_id` sorts by age.
- **Terraform** — describes cloud infrastructure in files, then creates it to match.
- **Ansible** — describes a server's desired configuration in files, then connects over SSH
  and applies it.
- **Elastic IP** — a fixed public IP address on AWS that stays yours across instance
  reboots.
