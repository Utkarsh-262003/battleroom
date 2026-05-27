// routes/leaderboard.js 
const express = require('express') 
const router  = express.Router() 
router.get('/',(req, res)=>{
    res.json({message : `Leaderboard`})
})

module.exports = router

