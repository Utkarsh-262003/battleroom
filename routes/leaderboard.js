const express = require('express')
const router = express.Router()
const GameResult = require('../models/GameResult')
const authMiddleware = require('../middleware/auth.js')

const LEADERBOARD_SIZE = 10

// Total score per player across every game they finished, best first.
router.get('/', authMiddleware, async (req, res) => {
  try {
    const leaders = await GameResult.aggregate([
      {
        $group: {
          _id: '$username',
          totalScore: { $sum: '$score' },
          gamesPlayed: { $sum: 1 }
        }
      },
      { $sort: { totalScore: -1, _id: 1 } },
      { $limit: LEADERBOARD_SIZE }
    ])

    res.json(leaders)
  } catch (err) {
    console.error('leaderboard failed:', err.message)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

module.exports = router
