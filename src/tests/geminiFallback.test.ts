// Gemini client: when the main model is overloaded, the call moves to a
// fallback model picked from the key's own model list.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const realFetch = globalThis.fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })

test('falls back to another flash model when the main one is overloaded', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(url)
    if (url.includes('?pageSize')) {
      return json(200, { models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.9-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
      ] })
    }
    if (url.includes('gemini-3.8-flash:')) return json(503, { error: { code: 503, message: 'high demand' } })
    if (url.includes('gemini-3.5-flash:')) return json(200, reply('ok from fallback'))
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch

  try {
    const { generateGemini } = await import('../utils/gemini.js')
    const text = await generateGemini({ apiKey: 'test', parts: [{ text: 'hi' }] })
    assert.equal(text, 'ok from fallback')
    // Main model tried once, then the newest full (non-lite, non-image) flash model
    assert.equal(calls.filter(u => u.includes('gemini-3.8-flash:')).length, 1)
    assert.ok(calls.some(u => u.includes('gemini-3.5-flash:')))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('names every model tried when all fail', async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.includes('?pageSize')) {
      return json(200, { models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] })
    }
    return json(400, { error: { code: 400, message: 'bad request' } })
  }) as typeof fetch
  try {
    const { generateGemini } = await import('../utils/gemini.js')
    // 400 is not retryable, so no fallback: the error names only the main model
    await assert.rejects(generateGemini({ apiKey: 'test', parts: [{ text: 'hi' }] }), /Gemini 400 \(tried gemini-3\.8-flash\)/)
  } finally {
    globalThis.fetch = realFetch
  }
})
