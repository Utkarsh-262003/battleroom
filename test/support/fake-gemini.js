// Preloaded into the app with `node -r` during tests. Every call to the
// Gemini API gets a canned question set instead of going to Google.
//
//   FAKE_GEMINI_FAIL_TIMES  the first N calls return 503 (busy)
//   FAKE_GEMINI_DELAY_MS    each call waits this long before answering
//
// Each call prints "fake-gemini call" so tests can count them.

const realFetch = globalThis.fetch
const failTimes = Number(process.env.FAKE_GEMINI_FAIL_TIMES) || 0
const delayMs = Number(process.env.FAKE_GEMINI_DELAY_MS) || 0
let calls = 0

function questions() {
  // 20 questions, one duplicate and one broken, to exercise filtering.
  // The correct answer is always first; the app must shuffle it.
  const list = []
  for (let i = 0; i < 18; i++) {
    list.push({
      question: `Test question ${i}?`,
      options: [`right ${i}`, `wrong a${i}`, `wrong b${i}`, `wrong c${i}`],
      correctOption: 0
    })
  }
  list.push({ question: 'Test question 0?', options: ['a', 'b', 'c', 'd'], correctOption: 0 })
  list.push({ question: 'Broken', options: ['only one'], correctOption: 0 })
  return list
}

globalThis.fetch = async (url, init) => {
  if (!String(url).includes('generativelanguage.googleapis.com')) {
    return realFetch(url, init)
  }

  calls++
  console.log('fake-gemini call')

  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))

  if (calls <= failTimes) {
    return new Response(JSON.stringify({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  }

  const body = {
    candidates: [{
      content: { role: 'model', parts: [{ text: JSON.stringify(questions()) }] },
      finishReason: 'STOP'
    }]
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
