// AI-drafted listing descriptions — grounded strictly in the facts an owner
// has already entered (price, bed/bath/m² or vehicle specs, amenities).
// Never invents features, distances, or trust-signal claims (VIEWORA_2_
// PRODUCT_SPEC.md's honesty principle: no fabricated stats/ratings/badges)
// — this text becomes public (detail page, brochure, WhatsApp link preview),
// so it's held to the same bar as anything else shown to a buyer.

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

const MODEL = 'claude-haiku-4-5-20251001'

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

const SYSTEM_PROMPT = `You write short listing descriptions for a Kenyan property/land/vehicle marketplace.

Rules:
- Base the description ONLY on the facts given. Never invent amenities, features, distances, condition claims, or numbers that aren't listed.
- Never use trust-signal or verification language ("Verified", "Trusted seller", "won't last long", response-time claims) — none of that exists on this platform.
- No emojis, no bullet points, no markdown, no hashtags.
- 2 to 4 sentences, natural and appealing but factual — like a good real, honest classifieds ad, not marketing copy.
- If very few facts are given, write a short, honest description anyway rather than padding with vague filler.
- Output ONLY the description text itself — no preamble, no quotes, no labels.`

export async function generateListingDescription(
  space: SpaceForDescription,
  apiKey: string,
): Promise<string> {
  const facts = buildFactLines(space).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 220,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Listing facts:\n${facts}` }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json() as any
  const text: string = (data.content?.[0]?.text ?? '').trim()
  if (!text) throw new Error('Empty response from Anthropic')
  return text
}
