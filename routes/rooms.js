const express = require('express') 
const router  = express.Router() 
  
router.get('/',       (req, res) => { res.json({ rooms: 'List of Rooms' })     }) 
router.post('/create',(req, res) => { res.json({ message: 'Room Created' })    }) 
  
module.exports = router