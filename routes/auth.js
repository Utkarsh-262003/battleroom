// routes/auth.js 
const express = require('express') 
const router  = express.Router() 
router.post('/login',(req, res)=>{
    res.json({message : 'Login Successfull'})
})

router.post('/signup',(req, res)=>{
    res.json({message : 'SignUp Successfull'})

})
module.exports = router