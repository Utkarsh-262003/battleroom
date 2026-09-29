const client = require('prom-client')

// ───────────────────────────────────────────────────────────
//  PROMETHEUS METRICS
// ───────────────────────────────────────────────────────────
//
// Everything is registered on one registry, which the separate
// metrics server on port 9101 serves. Nothing here is exposed
// through the public app.

const register = new client.Registry()

client.collectDefaultMetrics({ register })

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
})

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register]
})

const activeWebSocketConnections = new client.Gauge({
  name: 'active_websocket_connections',
  help: 'Number of currently connected WebSocket clients',
  registers: [register]
})

const activeGameRooms = new client.Gauge({
  name: 'active_game_rooms',
  help: 'Number of currently active game rooms',
  registers: [register]
})

// Game starts happen over WebSockets, so a failing Gemini API never
// shows up in the HTTP metrics. This counter makes it visible.
const questionGenerations = new client.Counter({
  name: 'question_generations_total',
  help: 'Attempts to generate a question set, by outcome',
  labelNames: ['outcome'],
  registers: [register]
})

// Start both series at zero. Prometheus cannot see an increase in a
// series that did not exist before, so the first failure would be lost.
questionGenerations.inc({ outcome: 'success' }, 0)
questionGenerations.inc({ outcome: 'failure' }, 0)

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  activeWebSocketConnections,
  activeGameRooms,
  questionGenerations
}
