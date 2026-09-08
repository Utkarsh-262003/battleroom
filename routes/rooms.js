const express = require('express')
const router = express.Router()
const mongoose = require('mongoose')
const authMiddleware = require('../middleware/auth.js')
const Room = require('../models/Room')

router.post('/:roomId/join', authMiddleware, async (req, res) => {
  const { roomId } = req.params
  const userId = req.user._id

  if (!mongoose.isValidObjectId(roomId)) {
    return res.status(400).json({ error: 'Invalid room id' })
  }

  try {
    const room = await Room.findById(roomId)
    if (!room) {
      return res.status(404).json({ error: 'Room Not Found' })
    }
    if (room.status !== 'waiting') {
      return res.status(403).json({ error: 'This room is not accepting players' })
    }

    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      { $addToSet: { players: userId } },
      { returnDocument: 'after' }
    )

    res.json({ message: 'Joined Successfully', room: updatedRoom })
  } catch (err) {
    // The old version returned 404 for every failure, which hid real errors
    // behind a wrong status code and made debugging impossible.
    console.error('join room failed:', err.message)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.get('/', authMiddleware, async (req, res) => {
  try {
    const rooms = await Room.find()
      .sort({ _id: -1 })
      .limit(50)
    res.json({ rooms })
  } catch (err) {
    console.error('list rooms failed:', err.message)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/create', authMiddleware, async (req, res) => {
  const name = req.body?.name

  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Room name is required' })
  }
  if (name.length > 60) {
    return res.status(400).json({ error: 'Room name is too long' })
  }

  try {
    const room = await Room.create({ name: name.trim(), host: req.user._id })
    res.json({ message: 'Room Created Successfully', roomId: room._id })
  } catch (err) {
    console.error('create room failed:', err.message)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

module.exports = router