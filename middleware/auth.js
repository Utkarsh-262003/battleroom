require('dotenv').config() 
const secret = process.env.JWT_SECRET
const jwt = require('jsonwebtoken')


module.exports = ((req, res, next) => { 
  const incomingToken = req.headers.authorization.split(" ")[1]
  try{
        req.user = jwt.verify(incomingToken, secret)      
          next()
  } 
   
  catch{
        res.status(401).json({ message: 'Invalid credentials' })
  }
}) 
