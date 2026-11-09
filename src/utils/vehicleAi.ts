// AI helpers for single-car listings: work out which side of the car each
// photo shows, and suggest hotspots (features / visible marks) on a photo.
// Everything returned is a SUGGESTION: the owner reviews it before it is saved,
// and nothing here is shown to buyers until they accept it.

import sharp from 'sharp'
import { generateGemini, type GeminiPart } from './gemini.js'

const PHOTO_WIDTH = 1024

async function loadPhoto(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const jpeg = await sharp(Buffer.from(await res.arrayBuffer()), { failOn: 'none' })
      .rotate()
      .resize(PHOTO_WIDTH, PHOTO_WIDTH, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer()
    return jpeg.toString('base64')
  } catch {
    return null
  }
}

export interface AngleSuggestion {
  id: string
  /** Degrees around the car, snapped to 15. null when the photo is not an exterior shot. */
  angle: number | null
  label: string | null
}

const ANGLE_PROMPT = `You are sorting photos of ONE car for a dealer's listing. Each numbered photo was taken from a different position around the car.

For each photo give "angle": which part of the car faces the camera, in degrees, snapped to the nearest 15.
- 0 = straight at the front (grille and headlights)
- 90 = the car's RIGHT side (the side on its right when you sit inside facing forward)
- 180 = straight at the rear (boot or tailgate, number plate)
- 270 = the car's LEFT side
- 45 = front-right corner, 135 = rear-right corner, 225 = rear-left corner, 315 = front-left corner. Use in-between values (e.g. 60) when the view sits between.
Use the car's own features to decide left from right (steering wheel side, fuel flap, badges, which way it faces). If you cannot tell, give your best estimate.

If a photo is NOT an outside view of the whole car (interior, engine bay, wheel close-up, documents), set "angle" to null.
"label": a short name like "Front", "Front right", "Right side", "Rear right", "Rear", "Rear left", "Left side", "Front left", or null when angle is null.

Return ONLY JSON: an array [{"n": <photo number>, "angle": <number|null>, "label": <string|null>}].`

export async function suggestAngles(
  apiKey: string,
  views: Array<{ id: string; image_url: string }>,
): Promise<AngleSuggestion[]> {
  const images = await Promise.all(views.map(v => loadPhoto(v.image_url)))
  const parts: GeminiPart[] = [{ text: ANGLE_PROMPT }]
  const sent: Array<{ id: string; n: number }> = []
  views.forEach((v, i) => {
    if (!images[i]) return
    const n = sent.length + 1
    sent.push({ id: v.id, n })
    parts.push({ text: `Photo ${n}:` })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: images[i]! } })
  })
  if (!sent.length) throw new Error('No readable photos')

  const text = await generateGemini({ apiKey, parts, json: true, maxOutputTokens: 4096 })
  let rows: any[]
  try { rows = JSON.parse(text) } catch { throw new Error('AI returned unreadable JSON') }
  if (!Array.isArray(rows)) throw new Error('AI returned an unexpected shape')

  const byN = new Map(sent.map(s => [s.n, s.id]))
  const out: AngleSuggestion[] = []
  for (const r of rows) {
    const id = byN.get(Number(r?.n))
    if (!id) continue
    const a = Number(r?.angle)
    const angle = r?.angle === null || !Number.isFinite(a) ? null : ((Math.round(a / 15) * 15) % 360 + 360) % 360
    out.push({ id, angle, label: typeof r?.label === 'string' ? r.label.slice(0, 40) : null })
  }
  return out
}

export interface HotspotSuggestion {
  kind: 'feature' | 'damage'
  x: number
  y: number
  title: string
  body: string | null
}

const HOTSPOT_PROMPT = `You help a car dealer add hotspots to one photo of a car for buyers. A hotspot is a small pin with a short note.

Suggest up to 6 hotspots for things a buyer would care about that you can CLEARLY see in this photo: alloy wheels or tyres, lights (LED, fog lamps), roof rails, a sunroof, a tow bar, a spoiler, side steps, a visible badge or trim name, chrome or body-kit details, tinted windows.
Also mark a visible scratch, dent, chip, rust or scuff as kind "damage", ONLY if you can plainly see it. Never guess at damage, and never invent a problem.

Rules:
- Only things actually visible in this photo. No claims about engine, mileage, service history, price or condition you cannot see.
- "x" and "y" are the point's position as fractions of the photo: x 0 = left edge, 1 = right edge; y 0 = top, 1 = bottom. Put the pin on the feature itself.
- "title": 2 to 4 words ("Alloy wheels", "LED headlights"). "body": one plain sentence of 20 words or fewer, or null.
- British / Kenyan English. No emojis, no hype words.
- If nothing worthwhile is visible, return an empty array.

Return ONLY JSON: [{"kind": "feature" | "damage", "x": 0.0-1.0, "y": 0.0-1.0, "title": "...", "body": "..." | null}].`

export async function suggestHotspots(apiKey: string, imageUrl: string, context?: string): Promise<HotspotSuggestion[]> {
  const img = await loadPhoto(imageUrl)
  if (!img) throw new Error('Could not read the photo')
  const parts: GeminiPart[] = [{ text: HOTSPOT_PROMPT }]
  if (context) parts.push({ text: `Context typed by the owner (may help identify the model): ${context}` })
  parts.push({ inline_data: { mime_type: 'image/jpeg', data: img } })

  const text = await generateGemini({ apiKey, parts, json: true, maxOutputTokens: 2048 })
  let rows: any[]
  try { rows = JSON.parse(text) } catch { throw new Error('AI returned unreadable JSON') }
  if (!Array.isArray(rows)) throw new Error('AI returned an unexpected shape')

  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const out: HotspotSuggestion[] = []
  for (const r of rows.slice(0, 6)) {
    const x = Number(r?.x), y = Number(r?.y)
    const title = typeof r?.title === 'string' ? r.title.trim().slice(0, 60) : ''
    if (!title || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({
      kind: r?.kind === 'damage' ? 'damage' : 'feature',
      x: clamp(x),
      y: clamp(y),
      title,
      body: typeof r?.body === 'string' && r.body.trim() ? r.body.trim().slice(0, 300) : null,
    })
  }
  return out
}

const CAPTION_PROMPT = `You name close-up photos of ONE car for a dealer's virtual tour. Buyers see each name under the photo's thumbnail.

For each numbered photo give "caption": what the photo shows, in 1 to 3 words, like "Front", "Rear", "Bonnet", "Engine bay", "Wheels", "Dashboard", "Infotainment", "Front seats", "Rear seats", "Boot", "Gear lever", "Odometer", "Sunroof", "Headlight", "Badge".
Name what is actually in the photo. Do not mention condition, price or anything you cannot see. British / Kenyan English, capital first letter only.

Return ONLY JSON: an array [{"n": <photo number>, "caption": "..."}].`

/** Short names for detail photos ("Wheels", "Dashboard"), in the order given. Unreadable photos are left out. */
export async function suggestCaptions(
  apiKey: string,
  photos: Array<{ id: string; url: string }>,
): Promise<Array<{ id: string; caption: string }>> {
  const images = await Promise.all(photos.map(p => loadPhoto(p.url)))
  const parts: GeminiPart[] = [{ text: CAPTION_PROMPT }]
  const sent: Array<{ id: string; n: number }> = []
  photos.forEach((p, i) => {
    if (!images[i]) return
    const n = sent.length + 1
    sent.push({ id: p.id, n })
    parts.push({ text: `Photo ${n}:` })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: images[i]! } })
  })
  if (!sent.length) throw new Error('No readable photos')
  const text = await generateGemini({ apiKey, parts, json: true, maxOutputTokens: 2048 })
  let rows: any[]
  try { rows = JSON.parse(text) } catch { throw new Error('AI returned unreadable JSON') }
  if (!Array.isArray(rows)) throw new Error('AI returned an unexpected shape')
  const byN = new Map(sent.map(s => [s.n, s.id]))
  const out: Array<{ id: string; caption: string }> = []
  for (const r of rows) {
    const id = byN.get(Number(r?.n))
    const caption = typeof r?.caption === 'string' ? r.caption.trim().slice(0, 40) : ''
    if (id && caption) out.push({ id, caption })
  }
  return out
}
