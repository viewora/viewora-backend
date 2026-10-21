// AI-drafted listing descriptions — grounded strictly in the facts an owner
// has already entered (price, bed/bath/m² or vehicle specs, amenities).
// Never invents features, distances, or trust-signal claims (VIEWORA_2_
// PRODUCT_SPEC.md's honesty principle: no fabricated stats/ratings/badges)
// — this text becomes public (detail page, brochure, WhatsApp link preview),
// so it's held to the same bar as anything else shown to a buyer.
//
// When the tour has 360° scenes, their thumbnails are shown to the model so it
// can describe what is genuinely visible (finishes, light, layout) — the
// photos are evidence too, but typed facts always win over what it sees.

import sharp from 'sharp'
import { generateGemini, type GeminiPart } from './gemini.js'
import { industryBrief } from './industry.js'

type SpaceForDescription = {
  title: string | null
  property_type: string | null
  location_text: string | null
  price_kes: number | null
  bedrooms: number | null
  bathrooms: number | null
  area_sqm: number | null
  vehicle_year: number | null
  vehicle_mileage_km: number | null
  vehicle_transmission: string | null
  vehicle_fuel_type: string | null
  land_acres?: number | null
  land_type?: string | null
  amenities: string[] | null
  listing_status: string | null
  transaction_type: string | null
  price_period: string | null
}

function buildFactLines(space: SpaceForDescription): string[] {
  const lines: string[] = []
  lines.push(`Title: ${space.title || 'Untitled listing'}`)
  lines.push(`Type: ${space.property_type || 'property'}`)
  if (space.location_text) lines.push(`Location: ${space.location_text}`)
  if (space.transaction_type) lines.push(`Listed for: ${space.transaction_type === 'rent' ? 'Rent' : 'Sale'}`)
  if (space.price_kes) {
    const period = space.transaction_type === 'rent' && space.price_period ? ` per ${space.price_period}` : ''
    lines.push(`Price: KES ${space.price_kes.toLocaleString('en-KE')}${period}`)
  }

  if (space.property_type === 'residential') {
    if (space.bedrooms != null) lines.push(`Bedrooms: ${space.bedrooms}`)
    if (space.bathrooms != null) lines.push(`Bathrooms: ${space.bathrooms}`)
    if (space.area_sqm != null) lines.push(`Floor area: ${space.area_sqm} m²`)
  } else if (space.property_type === 'automotive') {
    if (space.vehicle_year != null) lines.push(`Year: ${space.vehicle_year}`)
    if (space.vehicle_mileage_km != null) lines.push(`Mileage: ${space.vehicle_mileage_km.toLocaleString('en-KE')} km`)
    if (space.vehicle_transmission) lines.push(`Transmission: ${space.vehicle_transmission}`)
    if (space.vehicle_fuel_type) lines.push(`Fuel type: ${space.vehicle_fuel_type}`)
  } else if (space.property_type === 'land') {
    if (space.land_acres != null) lines.push(`Land size: ${space.land_acres} acres`)
    if (space.land_type) lines.push(`Land use / zoning: ${space.land_type}`)
  } else if (space.area_sqm != null) {
    lines.push(`Floor area: ${space.area_sqm} m²`)
  }

  if (space.amenities?.length) lines.push(`Amenities: ${space.amenities.join(', ')}`)
  if (space.listing_status && space.listing_status !== 'available') lines.push(`Status: ${space.listing_status}`)

  return lines
}

export type SceneForDescription = { name: string | null; thumbnailUrl: string }

// Enough to recognise rooms and finishes; keeps the request small for the free tier
const MAX_SCENE_IMAGES   = 8
const SCENE_IMAGE_WIDTH  = 1024

const SYSTEM_PROMPT = `You write the public description for a Viewora listing. Viewora hosts 360° tours for many industries — homes, hotels and restaurants, schools, offices and shops, car dealerships and vehicles, land, gyms, churches, clinics and other venues. The <industry> block tells you which one this is and who reads it. Write the way a trusted local expert in THAT industry talks to a serious customer: warm, specific, plain-spoken, confident without hype. A hotel description speaks to guests, a school to parents, a dealership to car buyers — only homes and land speak to buyers or tenants.

Sources of truth, in order:
1. LISTING FACTS — always correct. Every number (price, bedrooms, size, year, mileage) comes only from here.
2. TOUR PHOTOS (360° panoramas, if provided) — you may describe what is clearly visible: the rooms that exist, finishes (tiles, wooden floors, granite tops), natural light, ceiling height, the garden, gate, parking, views, layout and flow between spaces. Only describe what you can actually see; if unsure what something is, leave it out.

Never:
- Invent numbers, brands, distances, nearby landmarks, schools, security claims, water/power reliability, ratings, capacities, or condition claims you cannot see.
- Contradict the facts (e.g. photos showing 2 bedrooms do not override "Bedrooms: 3" — you may just have not seen them all).
- Use trust-signal or urgency language ("verified", "trusted seller", "won't last long", "rare opportunity").
- Use these tired phrases: nestled, boasts, stunning, breathtaking, dream home, look no further, oasis, haven, must-see, immaculate, luxurious living.
- Use emojis, bullet points, markdown, hashtags, headings, or exclamation marks.

Style:
- British/Kenyan English spelling. Natural rhythm — mix short and longer sentences. Concrete details over adjectives.
- Walk the reader through the place in a sensible order for its industry (a home: arrival → living → kitchen → bedrooms → outside; a hotel: arrival → rooms → dining → leisure; a car: exterior → cabin → features), as if showing them around.
- Open with what makes this place worth a look; close with who it suits (a young family, a team of ten, weekend travellers, a first car…) based only on the facts and photos.
- Length: two short paragraphs, 90–170 words total. With very few facts and no photos, write 2–3 honest sentences instead of padding.
- Output ONLY the description text — no preamble, no quotes, no labels.`

async function loadSceneImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const jpeg = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(SCENE_IMAGE_WIDTH, SCENE_IMAGE_WIDTH / 2, { fit: 'fill' })
      .jpeg({ quality: 80 })
      .toBuffer()
    return jpeg.toString('base64')
  } catch {
    return null
  }
}

export async function generateListingDescription(
  space: SpaceForDescription,
  apiKey: string,
  scenes: SceneForDescription[] = [],
): Promise<string> {
  const facts = buildFactLines(space).join('\n')
  const parts: GeminiPart[] = [
    { text: industryBrief(space.property_type, space.title) },
    { text: `LISTING FACTS:\n${facts}` },
  ]

  const picked = scenes.slice(0, MAX_SCENE_IMAGES)
  const images = await Promise.all(picked.map(s => loadSceneImage(s.thumbnailUrl)))
  const seen   = picked.flatMap((s, i) => images[i] ? [{ name: s.name, data: images[i]! }] : [])
  if (seen.length) {
    parts.push({ text: `TOUR PHOTOS: ${seen.length} equirectangular 360° panoramas (the left and right edges join up). Scene names were typed by the owner and may be generic.` })
    seen.forEach((s, i) => {
      parts.push({ text: `Scene ${i + 1}${s.name ? ` — "${s.name}"` : ''}:` })
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: s.data } })
    })
  }

  const text = await generateGemini({ apiKey, systemText: SYSTEM_PROMPT, parts, maxOutputTokens: 4096 })
  if (!text) throw new Error('Empty response from Gemini')
  return text.replace(/^["“]|["”]$/g, '').trim().slice(0, 2000)
}
