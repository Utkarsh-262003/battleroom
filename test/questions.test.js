const test = require('node:test')
const assert = require('node:assert/strict')

const { selectQuestions, shuffleOptions, isValidQuestion, QUESTION_COUNT } = require('../lib/questions')

function makeQuestion(i) {
  return {
    question: `Question ${i}?`,
    options: [`right ${i}`, `wrong a${i}`, `wrong b${i}`, `wrong c${i}`],
    correctOption: 0
  }
}

test('keeps valid, unique questions up to the limit', () => {
  const input = []
  for (let i = 0; i < 25; i++) input.push(makeQuestion(i))
  input.splice(3, 0, { ...makeQuestion(1), question: 'question 1' })

  const result = selectQuestions(input)

  assert.equal(result.length, QUESTION_COUNT)
  const texts = result.map(q => q.question)
  assert.equal(new Set(texts).size, texts.length, 'no duplicates')
  assert.ok(!texts.includes('question 1'), 'near-duplicate removed')
})

test('rejects malformed questions', () => {
  assert.equal(isValidQuestion(makeQuestion(1)), true)
  assert.equal(isValidQuestion(null), false)
  assert.equal(isValidQuestion({ ...makeQuestion(1), options: ['a', 'b', 'c'] }), false)
  assert.equal(isValidQuestion({ ...makeQuestion(1), options: ['a', 'a', 'b', 'c'] }), false, 'repeated option')
  assert.equal(isValidQuestion({ ...makeQuestion(1), options: ['a', '', 'b', 'c'] }), false, 'empty option')
  assert.equal(isValidQuestion({ ...makeQuestion(1), correctOption: 4 }), false)
  assert.equal(isValidQuestion({ ...makeQuestion(1), correctOption: '0' }), false)
  assert.equal(isValidQuestion({ ...makeQuestion(1), question: '   ' }), false)
})

test('throws when nothing usable comes back', () => {
  assert.throws(() => selectQuestions({ not: 'an array' }), /did not return an array/)
  assert.throws(() => selectQuestions([{ question: 'x' }]), /no usable questions/)
})

test('shuffling keeps the right answer attached to its text', () => {
  for (let i = 0; i < 50; i++) {
    const q = makeQuestion(i)
    const shuffled = shuffleOptions(q)
    assert.equal(shuffled.options[shuffled.correctOption], `right ${i}`)
    assert.deepEqual([...shuffled.options].sort(), [...q.options].sort())
  }
})

test('the right answer lands in every position about equally', () => {
  const counts = [0, 0, 0, 0]
  const runs = 4000
  for (let i = 0; i < runs; i++) counts[shuffleOptions(makeQuestion(i)).correctOption]++

  // Each position should get about 1000. 800 is far outside chance.
  for (const count of counts) assert.ok(count > 800, `positions: ${counts.join(', ')}`)
})
