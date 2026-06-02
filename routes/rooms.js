const express = require('express') 
const router  = express.Router() 
const authMiddleware = require('../middleware/auth.js')
const Room = require('../models/Room')
  
router.post('/:roomId/join', authMiddleware, async (req, res) => { 
    const roomId = req.params.roomId
    const userId = req.user._id
    
    try{
        const rooms = await Room.findById(roomId)
        if(rooms.status != 'waiting'){
            res.status(403).json({error : 'Not Authozised to join the room'})
            return
        }
       const updatedRoom = await Room.findByIdAndUpdate(
        roomId,
        { $addToSet: { players: userId } },
        { new: true }
        )
        res.json({ message: 'Joined Successfully', room: updatedRoom })

    }
    catch(err){
        res.status(404).json({error : 'Room Not Found'})
    }
    }) 

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




