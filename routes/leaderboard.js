// routes/leaderboard.js 
const express = require('express') 
const router  = express.Router() 
const GameResult = require('../models/GameResult')
const authMiddleware = require('../middleware/auth.js')

router.get('/',authMiddleware, async(req, res)=>{
    try{
    res.json(await GameResult.aggregate([
  { $group: {
      _id: '$username',           // group by this field
      totalScore: { $sum: '$score' }  // sum the score field for each group
  }},
  { $sort: { totalScore: -1 }}    // -1 = descending (highest first)
]) )}
catch(err){
    res.status(500).json({error : "Internal Server Error"})
}
})

module.exports = router

