const express = require('express') 
const router  = express.Router() 
const authMiddleware = require('../middleware/auth.js')

  
router.get('/', authMiddleware, (req, res) => { res.json({ rooms: 'List of Rooms' })     }) 
router.post('/create', authMiddleware, (req, res) => { res.json({ message: 'Room Created' })    }) 
  
module.exports = router