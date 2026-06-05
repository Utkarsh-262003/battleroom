const mongoose = require('mongoose')

const GameResult = new mongoose.Schema({
  username:     { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
  score: { type: Number, required: true },
  roomName: { type: String, required: true }
  },{timestamps: true})

module.exports = mongoose.model('GameResult', GameResult)