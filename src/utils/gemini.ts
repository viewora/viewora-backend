// Minimal Gemini REST client shared by the AI features (auto-link, listing
// descriptions). Model is configurable because Google's free-tier quotas
// differ per model — see GEMINI_MODEL in .env.example.

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
// Photo edits (object removal / insertion). No free tier — every call is billed,
// so it is only reachable through the plan's ai_image_edits_per_month allowance.
// The Lite model is the cheapest; gemini-nano-banana-2.1 gives better quality.
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image'

const MAX_RETRIES = 3

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

async function postGemini(model: string, apiKey: string, body: string): Promise<any> {
  let res: Response | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method:  'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body,
    })
    // Free tier is rate-limited per minute — back off and retry on 429 / transient 5xx
    if (res.ok || ![429, 500, 503].includes(res.status) || attempt === MAX_RETRIES) break
    const errText = await res.text()
    const hinted  = Number(errText.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1])
    const waitMs  = Math.min(30_000, Number.isFinite(hinted) ? hinted * 1000 : 4000 * 2 ** attempt)
    await new Promise(r => setTimeout(r, waitMs))
  }

  if (!res!.ok) {
    const errBody = await res!.text()
    throw new Error(`Gemini ${res!.status}: ${errBody.slice(0, 200)}`)
  }
  return res!.json()
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
  }))
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

/** Strips accidental ```json fences and parses. Throws on invalid JSON. */
export function parseGeminiJson(text: string): any {
  return JSON.parse(text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim() || '{}')
}
