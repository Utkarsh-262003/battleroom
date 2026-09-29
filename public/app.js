// ══════════════════════════════════
//  STATE
// ══════════════════════════════════
let token = null
let currentUser = null
let socket = null
let currentRoomId = null
let currentQuestionNumber = null
let selectedIndex = null
let lastRoomState = null
let starting = false

const MAX_LOBBY_ROOMS = 5

// The login and the room you are in survive a page refresh, but not
// closing the tab. sessionStorage is per tab, so two tabs can be two
// different players.
const SESSION_KEY = 'battleroom.session'
const ROOM_KEY = 'battleroom.room'

const $ = id => document.getElementById(id)

// ══════════════════════════════════
//  SAFE DOM HELPERS
// ══════════════════════════════════
// Every piece of data that came from a user or the server goes through
// textContent, never innerHTML. Room names and usernames are chosen by
// people; building HTML strings out of them is how stored XSS happens.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const ROOM_STATUSES = ['waiting', 'in-progress', 'finished']

function badgeClass(status) {
  return ROOM_STATUSES.includes(status) ? `badge badge-${status}` : 'badge'
}

// ══════════════════════════════════
//  STORAGE
// ══════════════════════════════════
// Storage can be blocked (private mode, strict settings). The game
// still works without it; only refresh-survival is lost.
function readStored(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) } catch { return null }
}

function writeStored(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

function clearStored(key) {
  try { sessionStorage.removeItem(key) } catch { /* ignore */ }
}

// ══════════════════════════════════
//  NAV + SCROLL
// ══════════════════════════════════
window.addEventListener('scroll', () => {
  $('mainNav').classList.toggle('scrolled', window.scrollY > 20)
})

const observer = new IntersectionObserver((entries) => {
  entries.forEach((e, i) => {
    if (e.isIntersecting) {
      setTimeout(() => e.target.classList.add('visible'), i * 80)
      observer.unobserve(e.target)
    }
  })
}, { threshold: 0.15 })
document.querySelectorAll('.reveal').forEach(node => observer.observe(node))

// ══════════════════════════════════
//  PANEL MANAGEMENT
// ══════════════════════════════════
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  $(id).classList.add('active')
}

function showError(elId, msg) {
  const node = $(elId)
  node.textContent = msg
  node.classList.add('visible')
  setTimeout(() => node.classList.remove('visible'), 4000)
}

function showSuccess(elId, msg) {
  const node = $(elId)
  node.textContent = msg
  node.classList.add('visible')
  setTimeout(() => node.classList.remove('visible'), 4000)
}

function setStatus(text, className) {
  $('status').textContent = text
  $('status').className = className || ''
}

// ══════════════════════════════════
//  AUTH
// ══════════════════════════════════
// Reads the payload of a JWT. The server verifies the signature; this
// is only to show the username and to notice an expired token.
function decodeToken(jwt) {
  try {
    const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

function isExpired(payload) {
  return !payload || (payload.exp && payload.exp * 1000 <= Date.now())
}

function signIn(newToken, payload) {
  token = newToken
  currentUser = { _id: payload._id, username: payload.username }
  writeStored(SESSION_KEY, { token })

  $('greeting').replaceChildren(
    document.createTextNode('Hey, '),
    el('strong', null, currentUser.username)
  )

  $('userBar').classList.add('active')
  showPanel('lobbyPanel')
  refreshLobby()
}

async function signup() {
  const name     = $('signupName').value.trim()
  const email    = $('signupEmail').value.trim()
  const username = $('signupUsername').value.trim()
  const password = $('signupPassword').value
  if (!name || !email || !username || !password) return showError('signupError', 'All fields required')
  if (password.length < 8) return showError('signupError', 'Password must be at least 8 characters')
  try {
    const res = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, username, password })
    })
    const data = await res.json()
    if (!res.ok) return showError('signupError', data.message || 'Signup failed')
    showSuccess('signupSuccess', 'Account created — redirecting to login...')
    setTimeout(() => showPanel('loginPanel'), 1500)
  } catch { showError('signupError', 'Network error') }
}

async function login() {
  const email    = $('loginEmail').value.trim()
  const password = $('loginPassword').value
  if (!email || !password) return showError('loginError', 'All fields required')
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (!res.ok) return showError('loginError', data.message || 'Login failed')
    const payload = decodeToken(data.token)
    if (!payload) return showError('loginError', 'Login failed')
    signIn(data.token, payload)
  } catch { showError('loginError', 'Network error') }
}

function resetGameView() {
  $('log').classList.remove('active')
  $('log').querySelector('.log-inner-wrap').replaceChildren()
  setStatus('')
  $('scoreboard').classList.remove('active')
  $('questionCard').classList.remove('active')
  $('gameOver').classList.remove('active')
}

function logout() {
  token = null; currentUser = null; currentRoomId = null
  clearStored(SESSION_KEY)
  clearStored(ROOM_KEY)
  if (socket) { socket.disconnect(); socket = null }
  $('userBar').classList.remove('active')
  resetGameView()
  showPanel('loginPanel')
}

// Picks up where the player was after a page refresh.
function restoreSession() {
  const saved = readStored(SESSION_KEY)
  if (!saved || typeof saved.token !== 'string') return

  const payload = decodeToken(saved.token)
  if (isExpired(payload)) {
    clearStored(SESSION_KEY)
    clearStored(ROOM_KEY)
    return
  }

  signIn(saved.token, payload)

  const room = readStored(ROOM_KEY)
  if (room && typeof room.roomId === 'string') {
    joinRoom(room.roomId, room.roomName || 'Room', { rejoin: true })
  }
}

// ══════════════════════════════════
//  ROOMS (REST)
// ══════════════════════════════════
function authHeaders() {
  return { 'Authorization': `Bearer ${token}` }
}

function emptyState(title, subtitle) {
  const wrap = el('div', 'empty-state')
  wrap.append(el('div', 'empty-mark'))
  wrap.append(el('p', null, title))
  if (subtitle) wrap.append(el('span', null, subtitle))
  return wrap
}

function roomCard(r) {
  const card = el('div', 'room-card')

  const top = el('div', 'room-card-top')
  top.append(el('div', 'room-name-text', r.name))
  top.append(el('span', badgeClass(r.status), r.status))
  card.append(top)

  const count = Number(r.playerCount) || 0
  card.append(el('div', 'room-meta',
    `${count} player${count !== 1 ? 's' : ''} · ID ${String(r._id).slice(-6)}`))

  if (r.status === 'waiting') {
    const btn = el('button', 'btn btn-primary btn-sm join-btn', 'Join Room')
    btn.dataset.roomId = r._id
    btn.dataset.roomName = r.name
    card.append(btn)
  } else {
    const btn = el('button', 'btn btn-ghost btn-sm', 'Unavailable')
    btn.disabled = true
    card.append(btn)
  }

  return card
}

async function fetchRooms() {
  const list = $('roomList')
  try {
    const res = await fetch('/rooms', { headers: authHeaders() })
    if (res.status === 401) return sessionExpired()
    const data = await res.json()
    // The server sends newest first. Show only the newest few.
    const rooms = (data.rooms || []).slice(0, MAX_LOBBY_ROOMS)

    list.replaceChildren()

    if (rooms.length === 0) {
      list.append(emptyState('No rooms yet', 'Be the first to create one'))
      return
    }

    rooms.forEach(r => list.append(roomCard(r)))
  } catch {
    list.replaceChildren(emptyState('Failed to load rooms'))
  }
}

function leaderRow(leader, rank) {
  const row = el('div', 'score-row')
  const name = el('span', 'score-name')
  const games = Number(leader.gamesPlayed) || 0

  name.append(
    el('span', 'leader-rank', rank),
    document.createTextNode(leader._id),
    el('span', 'leader-games', `${games} game${games !== 1 ? 's' : ''}`)
  )

  row.append(name, el('span', 'score-pts', leader.totalScore))
  return row
}

async function fetchLeaderboard() {
  const box = $('leaderboardRows')
  try {
    const res = await fetch('/leaderboard', { headers: authHeaders() })
    if (!res.ok) throw new Error('leaderboard failed')
    const leaders = await res.json()

    box.replaceChildren()

    if (!Array.isArray(leaders) || leaders.length === 0) {
      box.append(el('div', 'leaderboard-empty', 'No finished games yet. Be the first!'))
      return
    }

    leaders.forEach((l, i) => box.append(leaderRow(l, i + 1)))
  } catch {
    box.replaceChildren(el('div', 'leaderboard-empty', 'Could not load the leaderboard'))
  }
}

function refreshLobby() {
  fetchRooms()
  fetchLeaderboard()
}

function sessionExpired() {
  logout()
  showError('loginError', 'Your session expired. Please sign in again.')
}

async function createRoom() {
  const name = $('createRoomName').value.trim()
  if (!name) return showError('createRoomError', 'Room name required')
  try {
    const res = await fetch('/rooms/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name })
    })
    const data = await res.json()
    if (!res.ok) return showError('createRoomError', data.error || 'Failed to create room')
    $('createRoomName').value = ''
    joinRoom(data.roomId, name)
  } catch { showError('createRoomError', 'Network error') }
}

// ══════════════════════════════════
//  WAITING ROOM
// ══════════════════════════════════
function renderRoomState(state) {
  lastRoomState = state
  const players = Array.isArray(state.players) ? state.players : []
  const isHost = currentUser && state.host === currentUser.username

  $('waitingCount').textContent = `${players.length} here`

  const rows = $('waitingPlayers')
  rows.replaceChildren()
  players.forEach(name => {
    const row = el('div', 'score-row')
    const label = currentUser && name === currentUser.username ? `${name} (you)` : name
    row.append(el('span', 'score-name', label))
    if (name === state.host) row.append(el('span', 'host-tag', 'Host'))
    rows.append(row)
  })

  const startBtn = $('startBtn')
  startBtn.style.display = isHost && state.status === 'waiting' ? '' : 'none'
  startBtn.disabled = starting
  startBtn.textContent = starting ? 'Generating questions…' : 'Start Game'

  let note
  if (state.status === 'in-progress') {
    note = 'A game is already running in this room.'
  } else if (starting) {
    note = 'Generating questions. This can take up to a minute.'
  } else if (isHost) {
    note = 'You are the host. Start when everyone is here.'
  } else if (state.host) {
    note = `Waiting for ${state.host} to start the game.`
  } else {
    note = 'The host left. If they do not come back soon, the next player becomes host.'
  }
  $('waitingNote').textContent = note
}

// ══════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════
// `rejoin` skips the REST join. It is used after a refresh, when you
// are already a member and the room may be mid-game.
async function joinRoom(roomId, roomName, { rejoin = false } = {}) {
  if (!rejoin) {
    try {
      const res = await fetch(`/rooms/${roomId}/join`, {
        method: 'POST', headers: authHeaders()
      })
      const data = await res.json()
      if (res.status === 401) return sessionExpired()
      if (!res.ok) { showError('lobbyNotice', data.error || 'Cannot join room'); return }
    } catch { showError('lobbyNotice', 'Network error joining room'); return }
  }

  currentRoomId = roomId
  lastRoomState = null
  starting = false
  writeStored(ROOM_KEY, { roomId, roomName })

  if (socket) socket.disconnect()
  socket = io({ auth: { token } })

  let firstConnect = true

  socket.on('connect', () => {
    setStatus(`connected · ${socket.id.slice(0, 8)}`, 'connected')
    $('log').classList.add('active')
    if (firstConnect) {
      $('log').querySelector('.log-inner-wrap').replaceChildren()
      log(`Joined "${roomName}"`, 'join')
    } else {
      log('Reconnected', 'join')
    }
    firstConnect = false
    // Sent on every (re)connect. The server puts you back where you
    // were, including mid-game. The username comes from the JWT.
    socket.emit('join-room', { roomId: currentRoomId })
  })

  socket.on('connect_error', err => {
    if (err && err.message === 'unauthorized') return sessionExpired()
    setStatus('connection failed', 'error')
  })

  socket.on('disconnect', reason => {
    if (reason === 'io client disconnect') return
    setStatus('connection lost · reconnecting…', 'error')
  })

  showPanel('waitingPanel')
  $('waitingInfo').replaceChildren(
    el('span', 'pulse'),
    document.createTextNode(`${roomName} · ${String(roomId).slice(-6)}`)
  )
  $('waitingPlayers').replaceChildren()
  $('waitingCount').textContent = ''
  $('waitingNote').textContent = 'Connecting…'
  $('startBtn').style.display = 'none'

  socket.on('room-state', renderRoomState)
  socket.on('player-joined', ({ username }) => log(`${username} joined`, 'join'))
  socket.on('player-left',   ({ username }) => log(`${username} left`, 'left'))

  socket.on('game-starting', () => {
    starting = true
    log('Generating questions…', '')
    if (lastRoomState) renderRoomState(lastRoomState)
  })

  socket.on('start-failed', ({ message }) => {
    starting = false
    log(message, 'left')
    if (lastRoomState) renderRoomState(lastRoomState)
    $('waitingNote').textContent = message
  })

  socket.on('new-question', (data) => {
    starting = false
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    $('questionCard').classList.add('active')
    $('gameOver').classList.remove('active')

    const counter = document.querySelector('#questionCard .q-eyebrow')
    if (counter) {
      counter.textContent = (data.number && data.total)
        ? `— Question ${data.number} of ${data.total}`
        : '— Question'
    }

    $('questionText').textContent = data.question
    currentQuestionNumber = data.number || null
    selectedIndex = null

    $('feedback').className = ''
    $('feedback').style.display = ''

    resetNextButton()
    nextBtn.style.display = 'none'

    // The bar starts from the time actually left, so a player who
    // reconnects mid-question sees the real deadline.
    const duration = Number(data.durationMs) || 15000
    const left = Math.min(duration, Math.max(0, Number(data.timeLeftMs ?? duration)))
    const fill = $('timerFill')
    fill.style.transition = 'none'
    fill.style.width = `${(left / duration) * 100}%`
    void fill.offsetHeight
    fill.style.transition = `width ${left / 1000}s linear`
    fill.style.width = '0%'

    const box = $('optionsBox')
    box.replaceChildren()
    ;(data.options || []).forEach((opt, i) => {
      const btn = el('button', 'option-btn', opt)
      btn.dataset.index = i
      btn.disabled = Boolean(data.answered)
      box.append(btn)
    })

    // Came back after answering this question already.
    if (data.answered) {
      $('feedback').textContent = 'You already answered this one.'
      $('feedback').className = 'correct'
      nextBtn.style.display = ''
    }
  })

  socket.on('answer-result', ({ correct, correctOption, points, scores }) => {
    const buttons = document.querySelectorAll('.option-btn')
    const rightBtn = buttons[correctOption]
    const rightText = rightBtn ? rightBtn.textContent : null

    const fb = $('feedback')
    if (correct) {
      fb.textContent = `✓ Correct — +${Number(points) || 0} points`
    } else {
      fb.textContent = rightText
        ? `✗ Wrong. Correct answer: ${rightText}`
        : '✗ Wrong answer'
    }
    fb.className = correct ? 'correct' : 'wrong'

    // Colour the options: correct one green, your wrong pick red.
    buttons.forEach((b, i) => {
      if (i === correctOption) {
        paintOption(b, '#F0FDF4', '#16A34A', '#166534')
      } else if (!correct && b.dataset.index === String(selectedIndex)) {
        paintOption(b, '#FEF2F2', '#DC2626', '#991B1B')
      }
    })
    renderScores(scores)
    document.querySelectorAll('.option-btn').forEach(b => b.disabled = true)
    nextBtn.style.display = ''
  })

  // Any player answered: refresh everyone's live scoreboard.
  socket.on('scores-update', ({ scores }) => renderScores(scores))

  // You answered your last question. Others may still be playing.
  socket.on('player-finished', ({ scores }) => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    $('questionCard').classList.add('active')
    nextBtn.style.display = 'none'
    currentQuestionNumber = null

    const counter = document.querySelector('#questionCard .q-eyebrow')
    if (counter) counter.textContent = '— All done'
    $('questionText').textContent = 'You finished! Waiting for the other players…'
    $('optionsBox').replaceChildren()
    $('feedback').className = ''

    const fill = $('timerFill')
    fill.style.transition = 'none'
    fill.style.width = '0%'

    renderScores(scores)
  })

  socket.on('game-over', ({ scores }) => {
    clearStored(ROOM_KEY)
    nextBtn.style.display = 'none'
    $('questionCard').classList.remove('active')
    $('gameOver').classList.add('active')
    renderScores(scores)
    renderFinalScores(scores)
    log('Game over', '')
  })

  // A deploy restarts the server. A waiting room survives it and the
  // socket reconnects on its own; a running game does not.
  socket.on('server-restarting', () => {
    const inGame = $('questionCard').classList.contains('active')
    if (!inGame) {
      log('Server restarting. Reconnecting…', 'left')
      return
    }
    leaveRoom()
    showError('lobbyNotice', 'The server restarted for an update, so that game ended. Sorry!')
  })

  socket.on('error', ({ message, code } = {}) => {
    // A start the server refused never sends start-failed.
    if (starting) {
      starting = false
      if (lastRoomState) renderRoomState(lastRoomState)
    }
    if (code === 'room-gone') {
      leaveRoom()
      showError('lobbyNotice', message || 'That room no longer exists')
      return
    }
    log(`Error: ${message}`, 'left')
  })
}

// ══════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════
function startGame() {
  if (!socket || starting) return
  starting = true
  $('startBtn').disabled = true
  $('startBtn').textContent = 'Generating questions…'
  socket.emit('start-game')
}

function submitAnswer(index, btn) {
  if (!socket) return
  selectedIndex = index
  socket.emit('submit-answer', { answer: index })
  document.querySelectorAll('.option-btn').forEach(b => b.disabled = true)
  btn.style.borderColor = 'var(--text-primary)'
  btn.style.background = 'var(--bg-secondary)'
}

function nextQuestion() {
  if (!socket || !currentQuestionNumber) return
  nextBtn.disabled = true
  socket.emit('next-question', { number: currentQuestionNumber })
}

function resetNextButton() {
  nextBtn.disabled = false
  nextBtn.textContent = 'Next →'
}

function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null }
  currentRoomId = null
  starting = false
  clearStored(ROOM_KEY)
  resetGameView()
  showPanel('lobbyPanel')
  refreshLobby()
}

// ══════════════════════════════════
//  HELPERS
// ══════════════════════════════════
function log(msg, cls = '') {
  const wrap = $('log').querySelector('.log-inner-wrap')
  wrap.append(el('div', cls || null, msg))
  wrap.scrollTop = wrap.scrollHeight
}

function paintOption(btn, bg, border, text) {
  btn.style.background = bg
  btn.style.borderColor = border
  btn.style.color = text
}

function scoreRow(name, pts, suffix = '') {
  const row = el('div', 'score-row')
  row.append(el('span', 'score-name', name))
  row.append(el('span', 'score-pts', `${pts}${suffix}`))
  return row
}

function renderScores(scores) {
  $('scoreboard').classList.add('active')
  const sorted = Object.entries(scores || {}).sort((a, b) => b[1] - a[1])
  $('sbPlayerCount').textContent = `${sorted.length} player${sorted.length !== 1 ? 's' : ''}`
  const rows = $('scoreRows')
  rows.replaceChildren()
  sorted.forEach(([name, pts]) => rows.append(scoreRow(name, pts)))
}

function renderFinalScores(scores) {
  const sorted = Object.entries(scores || {}).sort((a, b) => b[1] - a[1])
  const medals = ['🥇', '🥈', '🥉']
  const box = $('finalScores')
  box.replaceChildren()
  sorted.forEach(([name, pts], i) => {
    const label = medals[i] ? `${medals[i]} ${name}` : name
    box.append(scoreRow(label, pts, ' pts'))
  })
}

// ══════════════════════════════════
//  NEXT BUTTON
// ══════════════════════════════════
// Built here so index.html doesn't need to change. It sits right under
// the answer feedback and only shows after you answer.
const nextRow = el('div')
nextRow.style.display = 'flex'
nextRow.style.justifyContent = 'flex-end'
nextRow.style.marginTop = 'var(--space-2)'

const nextBtn = el('button', 'btn btn-primary btn-sm', 'Next →')
nextBtn.id = 'nextBtn'
nextBtn.style.display = 'none'
nextRow.append(nextBtn)
$('feedback').after(nextRow)

// ══════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════

// Auth
$('loginBtn').addEventListener('click', login)
$('signupBtn').addEventListener('click', signup)
$('logoutBtn').addEventListener('click', logout)
$('toSignupBtn').addEventListener('click', () => showPanel('signupPanel'))
$('toLoginBtn').addEventListener('click', () => showPanel('loginPanel'))

// Enter key support
$('loginEmail').addEventListener('keydown',    e => { if (e.key === 'Enter') login() })
$('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') login() })
$('signupPassword').addEventListener('keydown',e => { if (e.key === 'Enter') signup() })
$('createRoomName').addEventListener('keydown',e => { if (e.key === 'Enter') createRoom() })

// Lobby
$('refreshRoomsBtn').addEventListener('click', refreshLobby)
$('newRoomBtn').addEventListener('click', () => showPanel('createRoomPanel'))
$('createRoomBtn').addEventListener('click', createRoom)
$('cancelCreateBtn').addEventListener('click', () => showPanel('lobbyPanel'))

// Waiting room
$('startBtn').addEventListener('click', startGame)
$('leaveWaitingBtn').addEventListener('click', leaveRoom)

// Game
$('leaveGameBtn').addEventListener('click', leaveRoom)
nextBtn.addEventListener('click', nextQuestion)
$('backToLobbyBtn').addEventListener('click', leaveRoom)

// Event delegation — room join buttons (dynamically rendered)
$('roomList').addEventListener('click', e => {
  const btn = e.target.closest('.join-btn')
  if (btn) joinRoom(btn.dataset.roomId, btn.dataset.roomName)
})

// Event delegation — answer option buttons (dynamically rendered)
$('optionsBox').addEventListener('click', e => {
  const btn = e.target.closest('.option-btn')
  if (btn && !btn.disabled) submitAnswer(parseInt(btn.dataset.index, 10), btn)
})

restoreSession()
