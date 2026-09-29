const { GoogleGenAI, Type } = require('@google/genai')

// ───────────────────────────────────────────────────────────
//  QUESTIONS (GEMINI)
// ───────────────────────────────────────────────────────────

const MODEL = 'gemini-2.5-flash'
const QUESTION_COUNT = 15
const QUESTION_EXTRA = 5
const TOPICS_PER_GAME = 5

// One attempt may not take longer than this. A hung request would
// otherwise leave every player in the room staring at "Starting…".
const REQUEST_TIMEOUT_MS = 45000

// Gemini returns 429 and 503 when it is busy. Those are retried with
// backoff (1s, then 2s) before the host sees an error.
const RETRY_OPTIONS = { attempts: 3, initialDelay: 1, maxDelay: 4 }

const TOPICS = [
  'world geography', 'space and astronomy', 'Indian history', 'world history',
  'human body', 'animals', 'inventions', 'sports', 'movies', 'music',
  'computers and the internet', 'mathematics', 'chemistry', 'physics',
  'food and cooking', 'famous books', 'languages', 'mythology',
  'oceans', 'famous buildings', 'money and economics', 'video games'
]

// Gemini is forced to return exactly this shape, so the reply no
// longer needs markdown fences stripped before parsing.
const QUESTIONS_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING },
      options: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        minItems: '4',
        maxItems: '4'
      },
      correctOption: { type: Type.INTEGER, minimum: 0, maximum: 3 }
    },
    required: ['question', 'options', 'correctOption'],
    propertyOrdering: ['question', 'options', 'correctOption']
  }
}

let ai = null

function getClient() {
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return ai
}

// Fisher-Yates. Sorting with a random comparator is biased.
function shuffle(items) {
  const copy = [...items]

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }

  return copy
}

function pickTopics() {
  return shuffle(TOPICS).slice(0, TOPICS_PER_GAME)
}

function isValidQuestion(q) {
  return Boolean(
    q &&
    typeof q.question === 'string' &&
    q.question.trim().length > 0 &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every(o => typeof o === 'string' && o.trim().length > 0) &&
    new Set(q.options).size === 4 &&
    Number.isInteger(q.correctOption) &&
    q.correctOption >= 0 &&
    q.correctOption <= 3
  )
}

// Language models are bad at putting the right answer in a random
// position, so the options are reordered here instead.
function shuffleOptions(q) {
  const order = shuffle([0, 1, 2, 3])

  return {
    question: q.question,
    options: order.map(i => q.options[i]),
    correctOption: order.indexOf(q.correctOption)
  }
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Keeps valid, non-duplicate questions, up to QUESTION_COUNT.
function selectQuestions(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error('Gemini did not return an array')
  }

  const seen = new Set()
  const questions = []

  for (const q of parsed) {
    if (!isValidQuestion(q)) continue

    const key = normalize(q.question)

    if (seen.has(key)) continue

    seen.add(key)
    questions.push(shuffleOptions(q))

    if (questions.length === QUESTION_COUNT) break
  }

  if (questions.length === 0) {
    throw new Error('Gemini returned no usable questions')
  }

  if (questions.length < QUESTION_COUNT) {
    console.warn(`Gemini gave ${questions.length}/${QUESTION_COUNT} usable questions`)
  }

  return questions
}

async function fetchQuestions() {
  const askFor = QUESTION_COUNT + QUESTION_EXTRA
  const topics = pickTopics().join(', ')

  const prompt = `Generate ${askFor} quiz questions.
  Spread them across these topics: ${topics}.
  Every question must be about a different fact. No two questions may ask the same thing.
  Mix easy, medium and hard.
  Each question has exactly 4 different options, and exactly one of them is correct.
  correctOption is the index of the correct answer in the options array.
  Random seed: ${Date.now()}`

  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: QUESTIONS_SCHEMA,
      temperature: 1.0,
      httpOptions: {
        timeout: REQUEST_TIMEOUT_MS,
        retryOptions: RETRY_OPTIONS
      }
    }
  })

  let parsed

  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new Error('Gemini returned unparseable JSON')
  }

  return selectQuestions(parsed)
}

module.exports = {
  fetchQuestions,
  selectQuestions,
  shuffleOptions,
  isValidQuestion,
  QUESTION_COUNT
}
