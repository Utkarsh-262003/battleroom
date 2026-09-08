// ══════════════════════════════════
//  STATE
// ══════════════════════════════════
let token = null
let currentUser = null
let socket = null
let currentRoomId = null

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
document.querySelectorAll('.reveal').forEach(el => observer.observe(el))

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

// ══════════════════════════════════
//  AUTH
// ══════════════════════════════════
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
    token = data.token
    const payload = JSON.parse(atob(token.split('.')[1]))
    currentUser = { _id: payload._id, username: payload.username }

    $('greeting').replaceChildren(
      document.createTextNode('Hey, '),
      el('strong', null, currentUser.username)
    )

    $('userBar').classList.add('active')
    showPanel('lobbyPanel')
    fetchRooms()
  } catch { showError('loginError', 'Network error') }
}

function logout() {
  token = null; currentUser = null
  if (socket) { socket.disconnect(); socket = null }
  $('userBar').classList.remove('active')
  $('log').classList.remove('active')
  $('log').querySelector('.log-inner-wrap').replaceChildren()
  $('status').textContent = ''
  $('status').className = ''
  $('scoreboard').classList.remove('active')
  $('questionCard').classList.remove('active')
  $('gameOver').classList.remove('active')
  showPanel('loginPanel')
}

// ══════════════════════════════════
//  ROOMS (REST)
// ══════════════════════════════════
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

  const count = r.players.length
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
    const res = await fetch('/rooms', { headers: { 'Authorization': `Bearer ${token}` } })
    const data = await res.json()
    const rooms = data.rooms || []

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

async function createRoom() {
  const name = $('createRoomName').value.trim()
  if (!name) return showError('createRoomError', 'Room name required')
  try {
    const res = await fetch('/rooms/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name })
    })
    const data = await res.json()
    if (!res.ok) return showError('createRoomError', data.error || 'Failed to create room')
    $('createRoomName').value = ''
    joinRoom(data.roomId, name)
  } catch { showError('createRoomError', 'Network error') }
}

// ══════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════
async function joinRoom(roomId, roomName) {
  try {
    const res = await fetch(`/rooms/${roomId}/join`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
    })
    const data = await res.json()
    if (!res.ok) { alert(data.error || 'Cannot join room'); return }
  } catch { alert('Network error joining room'); return }

  currentRoomId = roomId
  if (socket) socket.disconnect()
  socket = io({ auth: { token } })

  socket.on('connect', () => {
    $('status').textContent = `connected · ${socket.id.slice(0, 8)}`
    $('status').className = 'connected'
    $('log').classList.add('active')
    $('log').querySelector('.log-inner-wrap').replaceChildren()
    // the server derives the username from the JWT, so it is not sent here
    socket.emit('join-room', { roomId: currentRoomId })
    log(`Joined "${roomName}"`, 'join')
  })

  socket.on('connect_error', () => {
    $('status').textContent = 'connection failed'
    $('status').className = 'error'
  })

  showPanel('waitingPanel')
  $('waitingInfo').replaceChildren(
    el('span', 'pulse'),
    document.createTextNode(`${roomName} · ${String(roomId).slice(-6)}`)
  )

  socket.on('player-joined', ({ username }) => log(`${username} joined`, 'join'))
  socket.on('player-left',   ({ socketId }) => log(`${String(socketId).slice(-4)} disconnected`, 'left'))

  socket.on('new-question', (data) => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    $('questionCard').classList.add('active')
    $('gameOver').classList.remove('active')
    $('questionText').textContent = data.question
    $('feedback').className = ''
    $('feedback').style.display = 'none'

    const fill = $('timerFill')
    fill.style.transition = 'none'
    fill.style.width = '100%'
    fill.offsetHeight
    fill.style.transition = 'width 15s linear'
    fill.style.width = '0%'

    const box = $('optionsBox')
    box.replaceChildren()
    ;(data.options || []).forEach((opt, i) => {
      const btn = el('button', 'option-btn', opt)
      btn.dataset.index = i
      box.append(btn)
    })
  })

  socket.on('answer-result', ({ correct, scores }) => {
    const fb = $('feedback')
    fb.textContent = correct ? '✓ Correct — +10 points' : '✗ Wrong answer'
    fb.className = correct ? 'correct' : 'wrong'
    renderScores(scores)
    document.querySelectorAll('.option-btn').forEach(b => b.disabled = true)
  })

  socket.on('game-over', ({ scores }) => {
    $('questionCard').classList.remove('active')
    $('gameOver').classList.add('active')
    renderScores(scores)
    renderFinalScores(scores)
    log('Game over', '')
  })

  socket.on('error', ({ message }) => log(`Error: ${message}`, 'left'))
}

// ══════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════
function startGame() { if (socket) socket.emit('start-game') }

function submitAnswer(index, btn) {
  if (!socket) return
  socket.emit('submit-answer', { answer: index })
  document.querySelectorAll('.option-btn').forEach(b => b.disabled = true)
  btn.style.borderColor = 'var(--text-primary)'
  btn.style.background = 'var(--bg-secondary)'
}

function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null }
  currentRoomId = null
  $('status').textContent = ''
  $('status').className = ''
  $('log').classList.remove('active')
  $('scoreboard').classList.remove('active')
  $('questionCard').classList.remove('active')
  $('gameOver').classList.remove('active')
  showPanel('lobbyPanel')
  fetchRooms()
}

// ══════════════════════════════════
//  HELPERS
// ══════════════════════════════════
function log(msg, cls = '') {
  const wrap = $('log').querySelector('.log-inner-wrap')
  wrap.append(el('div', cls || null, msg))
  wrap.scrollTop = wrap.scrollHeight
}

function scoreRow(name, pts, suffix = '') {
  const row = el('div', 'score-row')
  row.append(el('span', 'score-name', name))
  row.append(el('span', 'score-pts', `${pts}${suffix}`))
  return row
}

function renderScores(scores) {
  $('scoreboard').classList.add('active')
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  $('sbPlayerCount').textContent = `${sorted.length} player${sorted.length !== 1 ? 's' : ''}`
  const rows = $('scoreRows')
  rows.replaceChildren()
  sorted.forEach(([name, pts]) => rows.append(scoreRow(name, pts)))
}

function renderFinalScores(scores) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const medals = ['🥇', '🥈', '🥉']
  const box = $('finalScores')
  box.replaceChildren()
  sorted.forEach(([name, pts], i) => {
    const label = medals[i] ? `${medals[i]} ${name}` : name
    box.append(scoreRow(label, pts, ' pts'))
  })
}

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
$('refreshRoomsBtn').addEventListener('click', fetchRooms)
$('newRoomBtn').addEventListener('click', () => showPanel('createRoomPanel'))
$('createRoomBtn').addEventListener('click', createRoom)
$('cancelCreateBtn').addEventListener('click', () => showPanel('lobbyPanel'))

// Waiting room
$('startBtn').addEventListener('click', startGame)
$('leaveWaitingBtn').addEventListener('click', leaveRoom)

// Game
$('leaveGameBtn').addEventListener('click', leaveRoom)
$('backToLobbyBtn').addEventListener('click', leaveRoom)

// Event delegation — room join buttons (dynamically rendered)
$('roomList').addEventListener('click', e => {
  const btn = e.target.closest('.join-btn')
  if (btn) joinRoom(btn.dataset.roomId, btn.dataset.roomName)
})

// Event delegation — answer option buttons (dynamically rendered)
$('optionsBox').addEventListener('click', e => {
  const btn = e.target.closest('.option-btn')
  if (btn && !btn.disabled) submitAnswer(parseInt(btn.dataset.index), btn)
})