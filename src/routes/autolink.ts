import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES           = 20
const CONFIDENCE_THRESHOLD = 50   // low enough to keep forced fallback doorways (confidence 60)
const DEG_TO_RAD           = Math.PI / 180
const DEFAULT_PITCH_RAD    = -8 * DEG_TO_RAD
const DEDUP_MIN_ANGLE_RAD  = 0.18   // ~10° — closer than this = duplicate

// Two-tier: Haiku does doorways + naming (fast, cheap).
// Sonnet does info hotspots + deletion review (needs real visual reasoning).
const MODEL_FAST     = 'claude-haiku-4-5-20251001'
const MODEL_ACCURATE = 'claude-sonnet-4-6'

type Doorway = {
  position_pct: number
  pitch_deg:    number
  leads_to:     string
  confidence:   number
}

type InfoHotspot = {
  position_pct: number
  pitch_deg:    number
  label:        string
  description:  string
}

type SceneAnalysis = {
  room_type:    string
  new_name:     string
  doorways:     Doorway[]
  info_hotspots: InfoHotspot[]
  remove_ids:   string[]   // IDs of existing hotspots the AI says should be removed
  model_used:   string
}

// ── Room vocabulary per property type ─────────────────────────────────────
const ROOM_VOCAB: Record<string, string> = {
  residential:  'bedroom, master bedroom, kids bedroom, bathroom, en-suite bathroom, guest bathroom, kitchen, open-plan kitchen, living room, lounge, dining room, study, home office, hallway, entrance hall, laundry room, storage room, garage, garden, balcony, staircase, utility room',
  commercial:   'open office, private office, executive office, meeting room, conference room, boardroom, reception, lobby, corridor, server room, break room, kitchen, bathroom, staircase, storage room, print room, co-working space',
  hospitality:  'standard room, deluxe room, superior room, suite, junior suite, lobby, reception, restaurant, bar, gym, spa, pool area, corridor, conference room, meeting room, business centre, rooftop terrace, event hall',
  education:    'classroom, lecture hall, laboratory, science lab, library, computer lab, staffroom, principal office, reception, corridor, gymnasium, sports hall, canteen, dining hall, storage room, toilet, art room, music room',
  automotive:   'showroom floor, service bay, reception, customer waiting area, parts room, detail bay, sales office, toilet, car wash bay, tyre bay',
  other:        'room, space, area, corridor, entrance, outdoor area, common area',
}

// ── Info hotspot content guide per property type ───────────────────────────
const INFO_GUIDE: Record<string, string> = {
  residential: `
    Kitchen: "Integrated Oven", "Induction Hob", "Kitchen Island", "Granite Worktops",
      "Marble Countertops", "Underfloor Heating", "American Fridge-Freezer"
    Bathroom: "Rainfall Shower", "Freestanding Bathtub", "Walk-In Shower",
      "Heated Towel Rail", "Double Vanity", "Jacuzzi Bath"
    Bedroom: "Built-In Wardrobes", "En-Suite Access", "Balcony Access", "Dressing Area"
    Living: "Feature Fireplace", "Bi-Fold Doors", "Vaulted Ceiling", "Bay Window",
      "Exposed Brick Wall", "Double-Height Ceiling"
    Outdoor: "South-Facing Garden", "Private Pool", "Roof Terrace", "City View",
      "Sea View", "Mature Trees", "Landscaped Garden"
    General: "Hardwood Flooring", "Underfloor Heating", "Smart Home System",
      "Solar Panels", "EV Charging Point"`,
  hospitality: `
    Room: "King-Size Bed", "Queen-Size Bed", "Twin Beds", "Rainforest Shower",
      "Private Balcony", "Sea View", "City View", "Garden View",
      "65-inch Smart TV", "Nespresso Machine", "Mini Bar", "Kitchenette"
    Public: "Infinity Pool", "Rooftop Bar", "Restaurant Capacity", "Spa Treatment Rooms",
      "Fully Equipped Gym", "Business Centre", "Conference Capacity"`,
  commercial: `
    "Seats X People", "Natural Light", "AV-Equipped", "Video Conferencing Ready",
    "Standing Desks", "Collaborative Space", "Private Phone Booths",
    "Kitchenette Access", "Secure Entry", "Server Room Access"`,
  education: `
    "Seats X Students", "Interactive Whiteboard", "Lab Equipment",
    "Natural Ventilation", "Computer Stations", "Projection System"`,
  automotive: `
    "Display Capacity X Vehicles", "4-Post Lift", "2-Post Lift",
    "Wheel Alignment Bay", "Paint Booth", "Diagnostic Equipment"`,
  other: `Notable features visible in the image that add real value for visitors.`,
}

// ── Cached static instruction ──────────────────────────────────────────────
const STATIC_INSTRUCTION = `<role>
You are an expert virtual tour editor. You work exactly like a skilled human editor who:
1. Reviews panoramic images to identify walkable passages and place precise navigation arrows
2. Spots notable room features and adds informative labels that help buyers/guests
3. Reviews any existing hotspots and removes ones that are wrong, misplaced, or duplicate
4. Names every scene with a professional, specific label

Your output must be production-ready — a human editor would be proud to sign off on it.
</role>

<projection>
The image is EQUIRECTANGULAR (2:1 aspect ratio):
• Horizontal: 0% = far-left (behind camera, left) | 50% = directly in front | 100% = far-right (behind camera, right)
• LEFT EDGE = RIGHT EDGE = same physical point. A door at 2% and 98% is ONE door.
• Vertical: top = ceiling | centre = eye level (horizon) | bottom = floor
• Objects near the vertical centre are least distorted. Distortion increases toward top/bottom.
• A wide door or archway — mark its GEOMETRIC CENTRE, not the left or right frame.
</projection>

<navigation_rules>
INCLUDE: open doorways, open archways, open corridors, open sliding/double doors
EXCLUDE: closed doors, windows, mirrors, decorative arches, glass partitions without gaps,
         dark corners where nothing is visible, the same opening counted twice
PRECISION: position_pct ±2%. pitch_deg = centre of the doorway opening height.
  Standard door at eye level: -5 to -12°. Camera tilted up: 0 to +8°. Camera tilted down: -15 to -25°.
CONFIDENCE: 90-100 = crystal clear | 75-89 = clear, minor uncertainty | 60-74 = probable | <58 = OMIT

CRITICAL — REACHABILITY RULE:
Every scene in the tour MUST have at least one navigation doorway so visitors can continue the tour.
If you cannot see a clear open doorway, you MUST still suggest the MOST LIKELY exit point based on:
  • The direction the previous/next scene seems to be (use scene names as clues)
  • The brightest or most open-looking area of the image
  • The area with the least furniture obstruction
  • Default to position_pct=50 (front) with confidence=60 only if truly nothing is visible
A scene with zero doorways = a dead end = the tour is broken. This is the worst possible outcome.
It is ALWAYS better to suggest a low-confidence doorway at a reasonable position than to leave
a scene with no navigation at all.
</navigation_rules>

<info_hotspot_rules>
Add info hotspots ONLY for features that genuinely help a buyer/guest understand or choose the property.
Quality over quantity: MAX 3 info hotspots per scene.
SKIP: plain walls, standard furniture, ordinary items found in every room.
POSITION: place the hotspot ON the feature (pointing at the appliance, window, etc).
FORMAT: label = 2-4 words | description = one sentence, max 12 words.
</info_hotspot_rules>

<deletion_rules>
Review each existing hotspot listed in the context. Flag for removal if:
  • A navigation arrow points at a wall, window, mirror, or closed door (no passage there)
  • Two navigation arrows from the same scene are within 10° of each other (duplicate)
  • An info hotspot label does not match what is visible at that position
Only flag hotspots you are highly confident (>80%) are wrong. When in doubt, keep it.
</deletion_rules>

<output_format>
Return ONLY valid compact JSON — zero markdown, zero explanation:
{"room_type":"<type>","new_name":"<name or empty string>","doorways":[{"position_pct":<int>,"pitch_deg":<int>,"leads_to":"<1-3 words>","confidence":<int>}],"info_hotspots":[{"position_pct":<int>,"pitch_deg":<int>,"label":"<2-4 words>","description":"<max 12 words>"}],"remove_ids":[<"existing_id",...>]}

new_name: precise room name from vocabulary. Empty string if current name is already correct.
remove_ids: array of hotspot ID strings to delete. Empty array [] if all existing are fine.
</output_format>`

// ── Per-scene context (not cached — changes per scene) ─────────────────────
function buildSceneContext(opts: {
  spaceTitle:       string
  spaceType:        string
  locationText:     string
  totalScenes:      number
  sceneIndex:       number
  sceneName:        string
  prevSceneName:    string | null
  nextSceneName:    string | null
  existingHotspots: Array<{ id: string; type: string; label: string; yaw: number; pitch: number }>
}): string {
  const vocab     = ROOM_VOCAB[opts.spaceType]     || ROOM_VOCAB.other
  const infoGuide = INFO_GUIDE[opts.spaceType]     || INFO_GUIDE.other
  const lines     = [
    '<scene_context>',
    `Property: "${opts.spaceTitle}" | type: ${opts.spaceType}${opts.locationText ? ` | location: ${opts.locationText}` : ''}`,
    `Scene: ${opts.sceneIndex + 1} of ${opts.totalScenes} — current name: "${opts.sceneName}"`,
  ]
  if (opts.prevSceneName) lines.push(`Previous scene: "${opts.prevSceneName}"`)
  if (opts.nextSceneName) lines.push(`Next scene: "${opts.nextSceneName}"`)
  lines.push(`Allowed room_type / new_name vocabulary: ${vocab}`)
  lines.push(`Relevant info hotspot examples for this property type: ${infoGuide}`)

  if (opts.existingHotspots.length) {
    lines.push('')
    lines.push('Existing hotspots in this scene (review each for accuracy):')
    for (const h of opts.existingHotspots) {
      const pct   = Math.round((h.yaw / (2 * Math.PI) + 0.5) * 100)
      const pitch = Math.round(h.pitch / DEG_TO_RAD)
      lines.push(`  - id:"${h.id}" type:${h.type} label:"${h.label}" position:${pct}% horiz, ${pitch}° vert`)
    }
  } else {
    lines.push('No existing hotspots in this scene yet.')
  }

  lines.push('</scene_context>')
  return lines.join('\n')
}

// ── Core API call ──────────────────────────────────────────────────────────
async function callClaude(
  thumbnailUrl: string,
  sceneContext: string,
  apiKey:       string,
  model:        string,
): Promise<SceneAnalysis> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [{
        role:    'user',
        content: [
          // Block 1: static instruction — cached (90% cheaper on repeat calls)
          { type: 'text', text: STATIC_INSTRUCTION, cache_control: { type: 'ephemeral' } },
          // Block 2: per-scene context — NOT cached (changes per scene)
          { type: 'text', text: sceneContext },
          // Block 3: the panorama image — fetched directly from CDN, no base64 overhead
          { type: 'image', source: { type: 'url', url: thumbnailUrl } },
        ],
      }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json() as any
  const text: string = data.content?.[0]?.text ?? '{}'

  try {
    const clean  = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
    const parsed = JSON.parse(clean)

    return {
      room_type: typeof parsed.room_type === 'string'
        ? parsed.room_type.toLowerCase().trim()
        : 'room',
      new_name: typeof parsed.new_name === 'string' ? parsed.new_name.trim() : '',
      doorways: Array.isArray(parsed.doorways)
        ? parsed.doorways
            .filter((d: any) =>
              typeof d.position_pct === 'number' &&
              typeof d.pitch_deg    === 'number' &&
              typeof d.confidence   === 'number' &&
              d.position_pct >= 0 && d.position_pct <= 100 &&
              d.confidence   >= CONFIDENCE_THRESHOLD,
            )
            .sort((a: any, b: any) => b.confidence - a.confidence)
        : [],
      info_hotspots: Array.isArray(parsed.info_hotspots)
        ? parsed.info_hotspots.filter((h: any) =>
            typeof h.position_pct === 'number' &&
            typeof h.pitch_deg    === 'number' &&
            typeof h.label        === 'string' &&
            h.label.length > 0,
          )
        : [],
      remove_ids: Array.isArray(parsed.remove_ids)
        ? parsed.remove_ids.filter((id: any) => typeof id === 'string')
        : [],
      model_used: model,
    }
  } catch {
    return { room_type: 'room', new_name: '', doorways: [], info_hotspots: [], remove_ids: [], model_used: model }
  }
}

// ── Two-tier analysis ──────────────────────────────────────────────────────
// Haiku: fast doorway + naming pass. Sonnet: adds info hotspots + deletion review.
// Both run per scene. Haiku result feeds Sonnet so it doesn't re-detect doorways.
async function analyzeScene(
  thumbnailUrl: string,
  sceneContext: string,
  apiKey:       string,
): Promise<SceneAnalysis> {
  // Phase 1 — Haiku (navigation + naming, cheap)
  const fast = await callClaude(thumbnailUrl, sceneContext, apiKey, MODEL_FAST)

  // Phase 2 — Sonnet (info hotspots + deletion review, always runs for the full editor experience)
  // Even if Haiku found good doorways, Sonnet is needed for feature detection + hotspot audit.
  try {
    const accurate = await callClaude(thumbnailUrl, sceneContext, apiKey, MODEL_ACCURATE)
    return {
      // Use Sonnet's doorways if it's more confident, else keep Haiku's
      room_type:     accurate.room_type !== 'room' ? accurate.room_type : fast.room_type,
      new_name:      accurate.new_name  || fast.new_name,
      doorways:      accurate.doorways.length > 0
        ? accurate.doorways
        : fast.doorways,
      info_hotspots: accurate.info_hotspots,    // Sonnet is better at feature detection
      remove_ids:    accurate.remove_ids,        // Sonnet is better at spatial audit
      model_used:    `${MODEL_FAST}+${MODEL_ACCURATE}`,
    }
  } catch {
    return { ...fast }   // Sonnet failed — use Haiku result without info hotspots
  }
}

// ── Coordinate helpers ─────────────────────────────────────────────────────
function titleCase(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function pctToYawRad(pct: number): number {
  return (pct / 100 - 0.5) * 2 * Math.PI
}

function oppositeYawRad(yawRad: number): number {
  const f = yawRad + Math.PI
  return f > Math.PI ? f - 2 * Math.PI : f
}

function angularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

function findMatchingDoorway(doorways: Doorway[], targetRoomType: string): Doorway | null {
  if (!doorways.length) return null
  const target = targetRoomType.toLowerCase()
  const exact  = doorways.find(d =>
    d.leads_to.toLowerCase().includes(target) || target.includes(d.leads_to.toLowerCase()),
  )
  return exact ?? doorways[0]
}

function deduplicate<T extends { fromSceneId: string; yaw: number; confidence_hint: number }>(
  suggestions: T[],
): T[] {
  const result: T[] = []
  for (const s of suggestions) {
    const isDuplicate = result.some(r =>
      r.fromSceneId === s.fromSceneId && angularDist(r.yaw, s.yaw) < DEDUP_MIN_ANGLE_RAD,
    )
    if (!isDuplicate) result.push(s)
  }
  return result
}

// ── Connectivity guarantee ─────────────────────────────────────────────────
// Ensures every scene has at least one outgoing AND one incoming navigation link.
// If the AI missed a doorway in a scene, that scene becomes a dead end.
// This function detects isolated scenes and inserts fallback links so the tour
// is always fully traversable — no scene is ever unreachable.
type NavSuggestion = {
  fromSceneId: string; fromSceneName: string
  toSceneId:   string; toSceneName:   string
  yaw: number; pitch: number
  label: string; doorwayDescription: string
  confidence_hint: number
}

function ensureFullConnectivity(
  scenes: Array<{ id: string; name: string }>,
  suggestions: NavSuggestion[],
  existingLinkedPairs: Set<string>,
): NavSuggestion[] {
  const extra: NavSuggestion[] = []

  // Build outgoing and incoming sets from existing links + new suggestions
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  for (const s of scenes) {
    outgoing.set(s.id, new Set())
    incoming.set(s.id, new Set())
  }

  for (const pair of existingLinkedPairs) {
    const [from, to] = pair.split(':')
    outgoing.get(from)?.add(to)
    incoming.get(to)?.add(from)
  }

  for (const s of suggestions) {
    outgoing.get(s.fromSceneId)?.add(s.toSceneId)
    incoming.get(s.toSceneId)?.add(s.fromSceneId)
  }

  // For each scene, ensure it has at least one outgoing AND one incoming link
  for (let i = 0; i < scenes.length; i++) {
    const scene    = scenes[i]
    const hasOut   = (outgoing.get(scene.id)?.size ?? 0) > 0
    const hasIn    = (incoming.get(scene.id)?.size ?? 0) > 0

    // Find the best neighbour to connect to (prefer adjacent in sequence)
    const candidates = [
      i + 1 < scenes.length ? scenes[i + 1] : null,
      i - 1 >= 0            ? scenes[i - 1] : null,
    ].filter((c): c is typeof scenes[number] => c !== null)

    if (!hasOut && candidates.length > 0) {
      const target = candidates[0]
      // Skip if this pair is already covered by existing links
      if (!existingLinkedPairs.has(`${scene.id}:${target.id}`)) {
        extra.push({
          fromSceneId:        scene.id,
          fromSceneName:      scene.name,
          toSceneId:          target.id,
          toSceneName:        target.name,
          yaw:                0,                 // front-facing — best guess
          pitch:              DEFAULT_PITCH_RAD,
          confidence_hint:    40,                // marked low so it sorts last
          label:              titleCase(target.name || 'Next Room'),
          doorwayDescription: 'Continue tour →',
        })
        outgoing.get(scene.id)?.add(target.id)
        incoming.get(target.id)?.add(scene.id)
      }
    }

    if (!hasIn && candidates.length > 0) {
      // Pick the neighbour that doesn't already have an outgoing link to this scene
      const source = candidates.find(c => !outgoing.get(c.id)?.has(scene.id)) ?? candidates[0]
      if (!existingLinkedPairs.has(`${source.id}:${scene.id}`)) {
        extra.push({
          fromSceneId:        source.id,
          fromSceneName:      source.name,
          toSceneId:          scene.id,
          toSceneName:        scene.name,
          yaw:                Math.PI,            // facing back — natural return direction
          pitch:              DEFAULT_PITCH_RAD,
          confidence_hint:    40,
          label:              titleCase(scene.name || 'Return'),
          doorwayDescription: '← Return',
        })
        outgoing.get(source.id)?.add(scene.id)
        incoming.get(scene.id)?.add(source.id)
      }
    }
  }

  return extra
}

// ── Route ──────────────────────────────────────────────────────────────────
export default async function (fastify: FastifyInstance) {
  fastify.post('/spaces/:spaceId/auto-link', {
    preHandler: [fastify.authenticate],
    config:     { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return reply.code(503).send({
        statusMessage: 'AI auto-link requires ANTHROPIC_API_KEY to be configured on the server.',
      })
    }

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id, title, property_type, location_text')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    const spaceType    = (space.property_type || 'other') as string
    const spaceTitle   = (space.title          || 'Property') as string
    const locationText = (space.location_text  || '') as string

    const { data: scenes, error: scenesErr } = await fastify.supabase
      .from('scenes')
      .select('id, name, thumbnail_url, order_index, captured_at')
      .eq('space_id', params.spaceId)
      .eq('status', 'ready')
      .order('captured_at', { ascending: true, nullsFirst: false })
      .order('order_index', { ascending: true })
      .limit(MAX_SCENES)

    if (scenesErr || !scenes?.length)
      return reply.code(400).send({ statusMessage: 'No ready scenes found for this tour.' })
    if (scenes.length < 2)
      return reply.code(400).send({ statusMessage: 'You need at least 2 ready scenes to auto-link.' })

    const sceneIds = scenes.map(s => s.id)

    // Fetch ALL existing hotspots across the tour in one query
    const { data: allHotspots } = await fastify.supabase
      .from('hotspots')
      .select('id, scene_id, type, label, yaw, pitch, target_scene_id')
      .in('scene_id', sceneIds)

    // Group hotspots by scene
    const hotspotsByScene: Record<string, any[]> = {}
    for (const h of (allHotspots ?? [])) {
      if (!hotspotsByScene[h.scene_id]) hotspotsByScene[h.scene_id] = []
      hotspotsByScene[h.scene_id].push(h)
    }

    // Track which pairs are already linked (for nav dedup)
    const linkedPairs = new Set<string>(
      (allHotspots ?? [])
        .filter((h: any) => h.type === 'scene_link' && h.target_scene_id)
        .map((h: any) => `${h.scene_id}:${h.target_scene_id}`),
    )

    // ── Analyse all scenes ─────────────────────────────────────────────────
    const analyses: Array<{ sceneId: string } & SceneAnalysis> = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      if (!scene.thumbnail_url) {
        analyses.push({ sceneId: scene.id, room_type: 'room', new_name: '', doorways: [], info_hotspots: [], remove_ids: [], model_used: 'none' })
        continue
      }

      const existing = (hotspotsByScene[scene.id] ?? []).map((h: any) => ({
        id:    h.id,
        type:  h.type,
        label: h.label || (h.type === 'scene_link' ? 'Navigation' : 'Info'),
        yaw:   Number(h.yaw   || 0),
        pitch: Number(h.pitch || 0),
      }))

      const context = buildSceneContext({
        spaceTitle,
        spaceType,
        locationText,
        totalScenes:      scenes.length,
        sceneIndex:       i,
        sceneName:        scene.name || `Scene ${i + 1}`,
        prevSceneName:    i > 0               ? (scenes[i - 1].name || null) : null,
        nextSceneName:    i < scenes.length-1 ? (scenes[i + 1].name || null) : null,
        existingHotspots: existing,
      })

      try {
        const result = await analyzeScene(scene.thumbnail_url, context, apiKey)
        analyses.push({ sceneId: scene.id, ...result })
        fastify.log.info({
          sceneId:      scene.id,
          room_type:    result.room_type,
          new_name:     result.new_name,
          doorways:     result.doorways.length,
          info_hs:      result.info_hotspots.length,
          remove_count: result.remove_ids.length,
          model_used:   result.model_used,
        }, '[autolink] scene analysed')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, sceneId: scene.id }, '[autolink] scene analysis failed')
        analyses.push({ sceneId: scene.id, room_type: 'room', new_name: '', doorways: [], info_hotspots: [], remove_ids: [], model_used: 'error' })
      }

      await new Promise(r => setTimeout(r, 250))
    }

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    // ── Navigation hotspot suggestions ─────────────────────────────────────
    const rawNav: Array<{
      fromSceneId: string; fromSceneName: string
      toSceneId:   string; toSceneName:   string
      yaw: number; pitch: number
      confidence_hint: number
      label: string; doorwayDescription: string
    }> = []

    for (let i = 0; i < scenes.length - 1; i++) {
      const a = scenes[i], b = scenes[i + 1]
      const analysisA = byId[a.id], analysisB = byId[b.id]
      const labelB    = titleCase(analysisB?.room_type || b.name)
      const labelA    = titleCase(analysisA?.room_type || a.name)

      if (!linkedPairs.has(`${a.id}:${b.id}`)) {
        const doorAB  = findMatchingDoorway(analysisA?.doorways ?? [], analysisB?.room_type ?? '')
        const yawAB   = doorAB ? pctToYawRad(doorAB.position_pct) : 0
        const pitchAB = doorAB ? doorAB.pitch_deg * DEG_TO_RAD : DEFAULT_PITCH_RAD
        rawNav.push({
          fromSceneId: a.id, fromSceneName: a.name,
          toSceneId: b.id, toSceneName: b.name,
          yaw: parseFloat(yawAB.toFixed(4)), pitch: parseFloat(pitchAB.toFixed(4)),
          confidence_hint: doorAB?.confidence ?? 50,
          label: labelB, doorwayDescription: doorAB?.leads_to ?? `Leads to ${labelB}`,
        })
      }

      if (!linkedPairs.has(`${b.id}:${a.id}`)) {
        const doorBA  = findMatchingDoorway(analysisB?.doorways ?? [], analysisA?.room_type ?? '')
        const forwardYaw = rawNav.find(s => s.fromSceneId === a.id && s.toSceneId === b.id)?.yaw ?? 0
        const yawBA   = doorBA ? pctToYawRad(doorBA.position_pct) : oppositeYawRad(forwardYaw)
        const pitchBA = doorBA ? doorBA.pitch_deg * DEG_TO_RAD : DEFAULT_PITCH_RAD
        rawNav.push({
          fromSceneId: b.id, fromSceneName: b.name,
          toSceneId: a.id, toSceneName: a.name,
          yaw: parseFloat(yawBA.toFixed(4)), pitch: parseFloat(pitchBA.toFixed(4)),
          confidence_hint: doorBA?.confidence ?? 50,
          label: labelA, doorwayDescription: doorBA?.leads_to ?? `Back to ${labelA}`,
        })
      }
    }

    rawNav.sort((a, b) => b.confidence_hint - a.confidence_hint)
    const deduped = deduplicate(rawNav)

    // Guarantee full connectivity — every scene must have at least one outgoing
    // and one incoming navigation link. If the AI missed doorways in a scene,
    // insert fallback links to adjacent scenes so no room is ever a dead end.
    const fallbacks = ensureFullConnectivity(scenes, deduped, linkedPairs)
    const suggestions = [...deduped, ...fallbacks].map(({ confidence_hint: _c, ...s }) => s)

    // ── Info hotspot suggestions ────────────────────────────────────────────
    const infoHotspots = analyses.flatMap(a => {
      const scene = scenes.find(s => s.id === a.sceneId)
      return (a.info_hotspots ?? []).map((h, i) => ({
        _id:        `ih_${a.sceneId}_${i}`,
        sceneId:    a.sceneId,
        sceneName:  scene?.name || '',
        yaw:        parseFloat(pctToYawRad(h.position_pct).toFixed(4)),
        pitch:      parseFloat((h.pitch_deg * DEG_TO_RAD).toFixed(4)),
        label:      h.label,
        description: h.description || '',
      }))
    })

    // ── Hotspot deletion suggestions ────────────────────────────────────────
    // Collect all AI-flagged hotspot IDs and attach scene + label for UI display
    const hotspotDeletions = analyses.flatMap(a =>
      (a.remove_ids ?? []).flatMap(id => {
        const h = (allHotspots ?? []).find((x: any) => x.id === id) as any
        if (!h) return []
        const scene = scenes.find(s => s.id === h.scene_id)
        return [{
          _id:       `del_${id}`,
          hotspotId: id,
          sceneId:   h.scene_id,
          sceneName: scene?.name || '',
          label:     h.label || 'Unlabelled hotspot',
          type:      h.type,
        }]
      }),
    )

    // ── Scene rename suggestions ────────────────────────────────────────────
    const sceneRenames = scenes.flatMap(s => {
      const analysis = byId[s.id]
      if (!analysis) return []
      const currentNorm   = (s.name || '').toLowerCase().trim()
      const suggestedRaw  = analysis.new_name || analysis.room_type
      const suggested     = titleCase(suggestedRaw)
      const suggestedNorm = suggested.toLowerCase()
      if (!suggestedRaw || suggestedRaw === 'room' || suggestedNorm === currentNorm) return []
      const isGeneric = /^scene\s+\d+$/i.test(s.name || '')
      if (isGeneric || analysis.new_name) {
        return [{ sceneId: s.id, currentName: s.name, suggestedName: suggested }]
      }
      return []
    })

    return reply.send({
      suggestions,
      infoHotspots,
      hotspotDeletions,
      sceneRenames,
      sceneCount: scenes.length,
    })
  })
}
