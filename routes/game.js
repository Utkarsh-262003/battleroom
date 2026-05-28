const express = require('express') 
const router  = express.Router() 
  
router.get('/:roomId', (req, res) => { 
  const roomId = req.params.roomId 
  res.json({ message: `Entering game ${roomId}` }) 
}) 
router.post('/answer', (req, res) => { res.json({ message: 'Correct' }) }) 
  
module.exports = router