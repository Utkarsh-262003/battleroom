const express = require('express') 
const router  = express.Router() 
const authMiddleware = require('../middleware/auth.js')
const Room = require('../models/Room')
  
router.get('/', authMiddleware, async (req, res) => { 
    try{
        const rooms = await Room.find()
        res.json({rooms})
    }
    catch(err){
        res.status(500).json({error : 'Internal Server Error'})
    }
    }) 
router.post('/create', authMiddleware, async(req, res) => {
    try {
        const name = req.body.name
        const host = req.user._id
       const room = await Room.create({ name, host}) 
        res.json({ message: 'Room Created Successfully' })
}
catch(err){
    res.status(500).json({error : 'Internal Server Error'})
}
})
module.exports = router