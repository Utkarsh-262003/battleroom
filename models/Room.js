const mongoose = require('mongoose')

const roomSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  host:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, required: true ,enum: ['waiting', 'in-progress', 'finished'], default: 'waiting' },
  questionSetReference: { type: mongoose.Schema.Types.ObjectId, required: false }})

module.exports = mongoose.model('Room', roomSchema)