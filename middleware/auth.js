const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
  const header = req.headers.authorization

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Invalid credentials' })
  }

  const incomingToken = header.slice('Bearer '.length).trim()
  if (!incomingToken) {
    return res.status(401).json({ message: 'Invalid credentials' })
  }

  try {
    req.user = jwt.verify(incomingToken, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ message: 'Invalid credentials' })
  }
}