// ══════════════════════════════════
//  STATE
// ══════════════════════════════════
let token = null
let currentUser = null
let socket = null
let currentRoomId = null

const $ = id => document.getElementById(id)

// ══════════════════════════════════
//  NAV + SCROLL
// ══════════════════════════════════
window.addEventListener('scroll', () => {
  document.getElementById('mainNav').classList.toggle('scrolled', window.scrollY > 20)
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
  const el = $(elId)
  el.textContent = msg
  el.classList.add('visible')
  setTimeout(() => el.classList.remove('visible'), 4000)
}

function showSuccess(elId, msg) {
  const el = $(elId)
  el.textContent = msg
  el.classList.add('visible')
  setTimeout(() => el.classList.remove('visible'), 4000)
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
    $('greeting').innerHTML = `Hey, <strong>${currentUser.username}</strong>`
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
  $('log').querySelector('.log-inner-wrap').innerHTML = ''
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
async function fetchRooms() {
  try {
    const res = await fetch('/rooms', { headers: { 'Authorization': `Bearer ${token}` } })
    const data = await res.json()
    const rooms = data.rooms || []
    const list = $('roomList')
    if (rooms.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-mark"></div><p>No rooms yet</p><span>Be the first to create one</span></div>`
      return
    }
    list.innerHTML = rooms.map(r => `
      <div class="room-card">
        <div class="room-card-top">
          <div class="room-name-text">${r.name}</div>
          <span class="badge badge-${r.status.replace(' ', '-')}">${r.status}</span>
        </div>
        <div class="room-meta">${r.players.length} player${r.players.length !== 1 ? 's' : ''} · ID ${r._id.slice(-6)}</div>
        ${r.status === 'waiting'
          ? `<button class="btn btn-primary btn-sm join-btn" data-room-id="${r._id}" data-room-name="${r.name}">Join Room</button>`
          : `<button class="btn btn-ghost btn-sm" disabled>Unavailable</button>`
        }
      </div>`).join('')
  } catch {
    $('roomList').innerHTML = '<div class="empty-state"><p>Failed to load rooms</p></div>'
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
    if (!res.ok && res.status !== 200) { alert(data.error || 'Cannot join room'); return }
  } catch { alert('Network error joining room'); return }

  currentRoomId = roomId
  if (socket) socket.disconnect()
  socket = io({ auth: { token } })

  socket.on('connect', () => {
    $('status').textContent = `connected · ${socket.id.slice(0, 8)}`
    $('status').className = 'connected'
    $('log').classList.add('active')
    $('log').querySelector('.log-inner-wrap').innerHTML = ''
    socket.emit('join-room', { roomId: currentRoomId, username: currentUser.username })
    log(`Joined "${roomName}"`, 'join')
  })

  socket.on('connect_error', () => {
    $('status').textContent = 'connection failed'
    $('status').className = 'error'
  })

  showPanel('waitingPanel')
  $('waitingInfo').innerHTML = `<span class="pulse"></span>${roomName} · ${roomId.slice(-6)}`

  socket.on('player-joined', ({ username }) => log(`${username} joined`, 'join'))
  socket.on('player-left',   ({ socketId }) => log(`${socketId.slice(-4)} disconnected`, 'left'))

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

    $('optionsBox').innerHTML = data.options
      .map((opt, i) => `<button class="option-btn" data-index="${i}">${opt}</button>`)
      .join('')
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
  const el = $('log').querySelector('.log-inner-wrap')
  el.innerHTML += `<div class="${cls}">${msg}</div>`
  el.scrollTop = el.scrollHeight
}

function renderScores(scores) {
  $('scoreboard').classList.add('active')
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  $('sbPlayerCount').textContent = `${sorted.length} player${sorted.length !== 1 ? 's' : ''}`
  $('scoreRows').innerHTML = sorted
    .map(([name, pts]) => `
      <div class="score-row">
        <span class="score-name">${name}</span>
        <span class="score-pts">${pts}</span>
      </div>`).join('')
}

function renderFinalScores(scores) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const medals = ['🥇', '🥈', '🥉']
  $('finalScores').innerHTML = sorted
    .map(([name, pts], i) => `
      <div class="score-row">
        <span class="score-name">${medals[i] || ''} ${name}</span>
        <span class="score-pts">${pts} pts</span>
      </div>`).join('')
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