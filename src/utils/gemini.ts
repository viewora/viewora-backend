// Minimal Gemini REST client shared by the AI features (auto-link, listing
// descriptions). Model is configurable because Google's free-tier quotas
// differ per model — see GEMINI_MODEL in .env.example.

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'
// Photo edits (object removal / insertion). No free tier — every call is billed,
// so it is only reachable through the plan's ai_image_edits_per_month allowance.
// The Lite model is the cheapest; gemini-nano-banana-2.1 gives better quality.
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image'

// Used when the main model is overloaded (503), rate-limited (429) or too slow.
// Unset: picked automatically from the models this key can use (see pickFallback).
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || ''

const MAX_RETRIES = 3
// Cloudflare drops the client connection at 100 s and its 524 carries no CORS
// headers, so the browser only sees "Failed to fetch". Finish well before that
// so the route can still answer with a readable error and refund the credit.
const TOTAL_BUDGET_MS   = 75_000
const MIN_ATTEMPT_MS    = 10_000
// With a fallback available, the main model gets one try of at most this long,
// leaving the rest of the budget for the fallback.
const PRIMARY_ATTEMPT_MS = 40_000
const RETRYABLE = [429, 500, 503]

const API = 'https://generativelanguage.googleapis.com/v1beta/models'

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

type Outcome = Response | 'timeout'

async function callOnce(model: string, apiKey: string, body: string, timeoutMs: number): Promise<Outcome> {
  try {
    return await fetch(`${API}/${model}:generateContent`, {
      method:  'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(timeoutMs),
    })
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout'
    throw err
  }
}

/** Tries one model, retrying 429 / transient 5xx with backoff while time allows. */
async function tryModel(
  model: string, apiKey: string, body: string,
  deadline: number, maxAttempts: number, perAttemptMs: number,
): Promise<Outcome> {
  let last: Outcome = 'timeout'
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const left = deadline - Date.now()
    if (left < MIN_ATTEMPT_MS) break
    last = await callOnce(model, apiKey, body, Math.min(left, perAttemptMs))
    if (last === 'timeout' || last.ok || !RETRYABLE.includes(last.status)) return last
    if (attempt === maxAttempts - 1) break
    const errText = await last.clone().text()
    const hinted  = Number(errText.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1])
    const waitMs  = Math.min(30_000, Number.isFinite(hinted) ? hinted * 1000 : 4000 * 2 ** attempt)
    if (deadline - Date.now() - waitMs < MIN_ATTEMPT_MS) break
    await new Promise(r => setTimeout(r, waitMs))
  }
  return last
}

// Google retires and renames models often, so instead of hardcoding a second
// name, ask which text models this key can call and take the newest other
// "flash" model. Cached per process; a failed lookup is retried next time.
let fallbackLookup: Promise<string | null> | null = null

function versionOf(name: string): number {
  return Number(name.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0)
}

async function pickFallback(apiKey: string, primary: string): Promise<string | null> {
  if (GEMINI_FALLBACK_MODEL) return GEMINI_FALLBACK_MODEL === primary ? null : GEMINI_FALLBACK_MODEL
  fallbackLookup ??= (async () => {
    try {
      const res = await fetch(`${API}?pageSize=200`, {
        headers: { 'x-goog-api-key': apiKey },
        signal:  AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const { models = [] } = await res.json() as { models?: any[] }
      const names = models
        .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(m => String(m.name ?? '').replace(/^models\//, ''))
        .filter(n => n && n !== primary && /flash/i.test(n)
          && !/(image|tts|audio|live|embed|preview|exp|thinking)/i.test(n))
      // Full "flash" before "flash-lite", then newest version first
      names.sort((a, b) =>
        Number(/lite/i.test(a)) - Number(/lite/i.test(b)) || versionOf(b) - versionOf(a))
      return names[0] ?? null
    } catch {
      return null
    }
  })()
  const picked = await fallbackLookup
  if (!picked) fallbackLookup = null
  return picked
}

async function postGemini(model: string, apiKey: string, body: string, allowFallback = false): Promise<any> {
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const tried = [model]
  let out = allowFallback
    ? await tryModel(model, apiKey, body, deadline, 1, PRIMARY_ATTEMPT_MS)
    : await tryModel(model, apiKey, body, deadline, MAX_RETRIES + 1, TOTAL_BUDGET_MS)

  const busy = out === 'timeout' || (!out.ok && RETRYABLE.includes(out.status))
  if (allowFallback && busy && deadline - Date.now() >= MIN_ATTEMPT_MS) {
    const alt = await pickFallback(apiKey, model)
    if (alt) {
      tried.push(alt)
      out = await tryModel(alt, apiKey, body, deadline, 2, TOTAL_BUDGET_MS)
    }
  }

  if (out === 'timeout') {
    throw new Error(`Gemini timed out after ${Math.round((Date.now() - (deadline - TOTAL_BUDGET_MS)) / 1000)}s (tried ${tried.join(', ')})`)
  }
  if (!out.ok) {
    const errBody = await out.text()
    throw new Error(`Gemini ${out.status} (tried ${tried.join(', ')}): ${errBody.slice(0, 200)}`)
  }
  return out.json()
}

export async function generateGemini(opts: {
  apiKey:           string
  parts:            GeminiPart[]
  systemText?:      string
  json?:            boolean
  maxOutputTokens?: number
}): Promise<string> {
  const data = await postGemini(GEMINI_MODEL, opts.apiKey, JSON.stringify({
    ...(opts.systemText ? { systemInstruction: { parts: [{ text: opts.systemText }] } } : {}),
    contents:         [{ role: 'user', parts: opts.parts }],
    generationConfig: {
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // Generous: thinking models spend part of this budget before answering
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  }), true)
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => (p.thought ? '' : p.text ?? ''))
    .join('')
    .trim()
}

/** Image-in, image-out edit. Returns the edited image bytes, or throws with the model's text reply. */
export async function generateGeminiImage(opts: {
  apiKey: string
  parts:  GeminiPart[]
}): Promise<Buffer> {
  const data = await postGemini(GEMINI_IMAGE_MODEL, opts.apiKey, JSON.stringify({
    contents:         [{ role: 'user', parts: opts.parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig:        { aspectRatio: '1:1' },
    },
  }))
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? []
  const img = parts.find(p => (p.inlineData ?? p.inline_data)?.data)
  if (!img) {
    const said = parts.map(p => p.text ?? '').join(' ').trim()
    throw new Error(said ? `Image model declined: ${said.slice(0, 200)}` : 'Image model returned no image')
  }
  return Buffer.from((img.inlineData ?? img.inline_data).data, 'base64')
}

/**
 * Short, key-free reason for an upstream failure, sent back next to the friendly
 * message so a failing AI call can be diagnosed from the browser's Network tab.
 * Routes answer these failures with 503, never 502: Cloudflare swaps an origin
 * 502 for its own page without CORS headers, so the browser only sees "Failed to fetch".
 */
export function failureReason(err: any): string {
  return String(err?.message ?? err ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)
}

/** Strips accidental ```json fences and parses. Throws on invalid JSON. */
export function parseGeminiJson(text: string): any {
  return JSON.parse(text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim() || '{}')
}
