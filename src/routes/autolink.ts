import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { generateGemini, parseGeminiJson, GEMINI_MODEL, type GeminiPart } from '../utils/gemini.js'
import { industryBrief } from '../utils/industry.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { renderPanoViews, viewPointToYawPitch, yawPitchToViewPoint, VIEW_YAWS_DEG } from '../utils/panoViews.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES           = 20
const CONFIDENCE_THRESHOLD = 50   // low enough to keep forced fallback doorways (confidence 60)
const DEG_TO_RAD           = Math.PI / 180
const DEFAULT_PITCH_RAD    = -8 * DEG_TO_RAD
const DEDUP_MIN_ANGLE_RAD  = 0.18   // ~10° — closer than this = duplicate

type DoorwayKind = 'door' | 'archway' | 'stairs_up' | 'stairs_down' | 'outdoor'
type InfoCategory = 'feature' | 'view' | 'highlight'

type Doorway = {
  position_pct: number
  pitch_deg:    number
  size_deg:     number   // angular height of the opening — drives arrow size
  kind:         DoorwayKind
  leads_to:     string
  confidence:   number
}

type InfoHotspot = {
  position_pct: number
  pitch_deg:    number
  size_deg:     number
  category:     InfoCategory
  label:        string
  description:  string
}

type HotspotFix = {
  id:            string
  position_pct?: number
  pitch_deg?:    number
  label?:        string
}

type SceneAnalysis = {
  room_type:      string
  new_name:       string
  doorways:       Doorway[]
  info_hotspots:  InfoHotspot[]
  remove_ids:     string[]   // IDs of existing hotspots the AI says should be removed
  fixes:          HotspotFix[]
  start_view_pct: number | null   // best opening direction, panorama %
  group:          string
  model_used:     string
}

const EMPTY_ANALYSIS: Omit<SceneAnalysis, 'model_used'> = {
  room_type: 'room', new_name: '', doorways: [], info_hotspots: [], remove_ids: [],
  fixes: [], start_view_pct: null, group: '',
}

// ── Hotspot styling — mirrors the editor's icon set (viewora-app shared/utils/hotspotIcons.ts)
const NAV_ICON = 'nav-up'
const INFO_ICON: Record<InfoCategory, string> = {
  feature:   'info-3d-light',
  view:      'camera-3d-light',
  highlight: 'star-yellow',
}

// Apparent size → marker scale, so near doorways get bigger arrows than far ones
function scaleFor(sizeDeg: number, kind: 'nav' | 'info'): number {
  const raw = kind === 'nav' ? sizeDeg / 40 : 0.8 + sizeDeg / 100
  const [lo, hi] = kind === 'nav' ? [0.7, 1.4] : [0.8, 1.2]
  return Math.round(Math.min(hi, Math.max(lo, raw)) * 20) / 20
}

// ── Room vocabulary per property type ─────────────────────────────────────
const ROOM_VOCAB: Record<string, string> = {
  residential:  'bedroom, master bedroom, kids bedroom, bathroom, en-suite bathroom, guest bathroom, kitchen, open-plan kitchen, living room, lounge, dining room, study, home office, hallway, entrance hall, laundry room, storage room, garage, garden, balcony, staircase, utility room',
  commercial:   'open office, private office, executive office, meeting room, conference room, boardroom, reception, lobby, corridor, server room, break room, kitchen, bathroom, staircase, storage room, print room, co-working space',
  hospitality:  'standard room, deluxe room, superior room, suite, junior suite, lobby, reception, restaurant, bar, gym, spa, pool area, corridor, conference room, meeting room, business centre, rooftop terrace, event hall',
  education:    'classroom, lecture hall, laboratory, science lab, library, computer lab, staffroom, principal office, reception, corridor, gymnasium, sports hall, canteen, dining hall, storage room, toilet, art room, music room',
  automotive:   'showroom floor, service bay, reception, customer waiting area, parts room, detail bay, sales office, toilet, car wash bay, tyre bay, vehicle interior, vehicle exterior, front seats, rear seats, boot, engine bay',
  land:         'plot, access road, entrance gate, boundary, beacon, open land, farmland, vegetation, viewpoint, neighbouring area',
  other:        'room, space, area, corridor, entrance, outdoor area, common area, reception, main hall, gym floor, studio, treatment room, sanctuary, workshop, waiting area (pick what fits the business)',
}

// ── Scene categories (scenes.group_name) per property type ─────────────────
const GROUP_VOCAB: Record<string, string> = {
  residential: 'Entrance, Living Areas, Kitchen & Dining, Bedrooms, Bathrooms, Outdoor, Other',
  commercial:  'Reception, Workspaces, Meeting Rooms, Facilities, Outdoor, Other',
  hospitality: 'Lobby, Rooms & Suites, Dining, Leisure, Meeting & Events, Outdoor, Other',
  education:   'Classrooms, Labs, Library, Sports, Facilities, Outdoor, Other',
  automotive:  'Showroom, Service, Customer Areas, Exterior, Interior, Other',
  land:        'Plots, Access, Surroundings, Other',
  other:       'Indoor, Outdoor, Other',
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
  land: `
    "Tarmac Access Road", "Corner Plot", "Boundary Beacon", "Gentle Slope", "Red Soil",
    "Mature Trees", "Mountain View", "Power Line Nearby", "Fenced Boundary"`,
  automotive: `
    "Leather Seats", "Touchscreen Infotainment", "Sunroof", "Alloy Wheels", "Spacious Boot",
    "Display Capacity X Vehicles", "4-Post Lift", "2-Post Lift",
    "Wheel Alignment Bay", "Paint Booth", "Diagnostic Equipment"`,
  other: `Notable features visible in the image that add real value for visitors.`,
}

// ── Cached static instruction ──────────────────────────────────────────────
const STATIC_INSTRUCTION = `<role>
You are a senior virtual tour editor. You do every job a skilled human editor does on a 360° tour:
1. Place precise navigation arrows on every walkable passage, and say what kind of passage it is
2. Add info hotspots on the features this tour's viewers (see <industry>) would genuinely want pointed out
3. Audit existing hotspots: delete wrong ones, move misplaced ones, rewrite weak labels
4. Name the scene, put it in the right category, and choose its best opening view

Your output must be production-ready — a human editor would be proud to sign off on it.
</role>

<views>
You receive ONE 360° panorama as ${VIEW_YAWS_DEG.length} flat perspective photos taken from the same spot,
numbered view 1..${VIEW_YAWS_DEG.length}, each 90° wide, turning clockwise ${VIEW_YAWS_DEG[1] - VIEW_YAWS_DEG[0]}° per view.
• View 1 faces the front. View ${VIEW_YAWS_DEG.length} wraps around to view 1.
• Adjacent views OVERLAP by 30°, so the same object can appear in two views.
  Report each object ONCE, in the view where it is most centred and fully visible.
• Locate things with box_2d = [ymin, xmin, ymax, xmax], normalised 0-1000 within that view.
• Doorway box: tightly around the walkable opening (floor to top of opening, frame to frame).
• Feature box: tightly around the feature itself.
</views>

<navigation_rules>
INCLUDE: open doorways, open archways, open corridors, open sliding/double doors, staircases, exits outside
EXCLUDE: closed doors, windows, mirrors, decorative arches, glass partitions without gaps,
         dark corners where nothing is visible, the same opening counted twice
PRECISION: box_2d must hug the opening — the arrow is placed at the box centre.
  For a staircase, box the first few steps you would walk onto.
KIND: "door" (doorway/sliding door) | "archway" (open arch or corridor) | "stairs_up" | "stairs_down" | "outdoor" (leads outside)
CONFIDENCE: 90-100 = crystal clear | 75-89 = clear, minor uncertainty | 60-74 = probable | <58 = OMIT

CRITICAL — REACHABILITY RULE:
Every scene in the tour MUST have at least one navigation doorway so visitors can continue the tour.
If you cannot see a clear open doorway, you MUST still suggest the MOST LIKELY exit point based on:
  • The direction the previous/next scene seems to be (use scene names as clues)
  • The brightest or most open-looking area of the image
  • The area with the least furniture obstruction
  • Default to the centre of view 1 with confidence=60 only if truly nothing is visible
A scene with zero doorways = a dead end = the tour is broken. This is the worst possible outcome.
It is ALWAYS better to suggest a low-confidence doorway at a reasonable position than to leave
a scene with no navigation at all.
</navigation_rules>

<info_hotspot_rules>
Add info hotspots ONLY for features that genuinely help this tour's viewers (see <industry>) understand or choose the place.
Quality over quantity: MAX 3 info hotspots per scene. Never duplicate an existing info hotspot.
SKIP: plain walls, standard furniture, ordinary items found in every room, the camera tripod/operator.
POSITION: box_2d around the feature (the appliance, window, etc) — the hotspot goes at its centre.
CATEGORY: "feature" (fixture, appliance, finish, storage) | "view" (window or outdoor view worth looking at)
  | "highlight" (THE standout selling point of this scene — at most ONE per scene, often none)
LABEL: 2-4 words, Title Case, specific ("Granite Kitchen Island", not "Kitchen Feature").
DESCRIPTION: one or two natural sentences, max 25 words, written like a friendly agent pointing it out
  on a viewing — concrete and visual, no hype words (stunning, luxurious, boasts, nestled).
  Only state what you can see; never invent brands, sizes or specs.
</info_hotspot_rules>

<audit_rules>
Review each existing hotspot listed in the context (its view and x/y position are given).
REMOVE (remove_ids) if you are >80% sure it is wrong:
  • A navigation arrow points at a wall, window, mirror, or closed door (no passage there)
  • Two navigation arrows from the same scene sit on the same opening (duplicate)
  • An info hotspot describes something that is not there
FIX (fix_hotspots) if it is right in spirit but needs correcting:
  • It is on the right object but visibly off-centre or floating beside it → give the corrected box_2d
  • Its label is vague, misspelt or generic ("Info hotspot", "Go to next room") → give a better label
  Only include the fields that change. Never both remove and fix the same id.
When in doubt, leave it alone.
</audit_rules>

<scene_rules>
new_name: precise room name from the vocabulary. Empty string if the current name is already correct.
group: the category this scene belongs in, from the category list.
start_view: where the tour should face when the scene opens — the most flattering, informative
  direction: looking INTO the space, showing its best side and natural light. Never a blank wall,
  a corner, a bathroom toilet, or the camera operator. Give the view and the x (0-1000) to centre on.
</scene_rules>

<output_format>
Return ONLY valid compact JSON — zero markdown, zero explanation:
{"room_type":"<type>","new_name":"<name or empty string>","group":"<category>","start_view":{"view":<1-${VIEW_YAWS_DEG.length}>,"x":<0-1000>},"doorways":[{"view":<1-${VIEW_YAWS_DEG.length}>,"box_2d":[<ymin>,<xmin>,<ymax>,<xmax>],"kind":"<kind>","leads_to":"<1-3 words>","confidence":<int>}],"info_hotspots":[{"view":<1-${VIEW_YAWS_DEG.length}>,"box_2d":[<ymin>,<xmin>,<ymax>,<xmax>],"category":"<category>","label":"<2-4 words>","description":"<max 25 words>"}],"remove_ids":[<"existing_id",...>],"fix_hotspots":[{"id":"<existing_id>","view":<optional>,"box_2d":<optional>,"label":"<optional>"}]}
Use [] for empty lists.
</output_format>`

// ── Per-scene context (not cached — changes per scene) ─────────────────────
function buildSceneContext(opts: {
  spaceTitle:       string
  spaceType:        string
  locationText:     string
  totalScenes:      number
  sceneIndex:       number
  sceneName:        string
  sceneGroup:       string | null
  prevSceneName:    string | null
  nextSceneName:    string | null
  existingHotspots: Array<{ id: string; type: string; label: string; yaw: number; pitch: number }>
}): string {
  const vocab     = ROOM_VOCAB[opts.spaceType]     || ROOM_VOCAB.other
  const infoGuide = INFO_GUIDE[opts.spaceType]     || INFO_GUIDE.other
  const lines     = [
    industryBrief(opts.spaceType, opts.spaceTitle),
    '<scene_context>',
    `Property: "${opts.spaceTitle}" | type: ${opts.spaceType}${opts.locationText ? ` | location: ${opts.locationText}` : ''}`,
    `Scene: ${opts.sceneIndex + 1} of ${opts.totalScenes} — current name: "${opts.sceneName}"`,
  ]
  if (opts.prevSceneName) lines.push(`Previous scene: "${opts.prevSceneName}"`)
  if (opts.nextSceneName) lines.push(`Next scene: "${opts.nextSceneName}"`)
  lines.push(`Allowed room_type / new_name vocabulary: ${vocab}`)
  lines.push(`Category list for group: ${GROUP_VOCAB[opts.spaceType] || GROUP_VOCAB.other}${opts.sceneGroup ? ` (currently "${opts.sceneGroup}")` : ''}`)
  lines.push(`Relevant info hotspot examples for this property type: ${infoGuide}`)

  if (opts.existingHotspots.length) {
    lines.push('')
    lines.push('Existing hotspots in this scene (review each for accuracy):')
    for (const h of opts.existingHotspots) {
      const at = yawPitchToViewPoint(h.yaw, h.pitch)
      const where = at
        ? `view ${at.view + 1} at x:${at.x} y:${at.y}`
        : `outside the views (${Math.round(h.pitch / DEG_TO_RAD)}° vertical)`
      lines.push(`  - id:"${h.id}" type:${h.type} label:"${h.label}" ${where}`)
    }
  } else {
    lines.push('No existing hotspots in this scene yet.')
  }

  lines.push('</scene_context>')
  return lines.join('\n')
}

// ── Core API call ──────────────────────────────────────────────────────────
type BoxPoint = { position_pct: number; pitch_deg: number; size_deg: number }

const DOORWAY_KINDS: DoorwayKind[]  = ['door', 'archway', 'stairs_up', 'stairs_down', 'outdoor']
const INFO_CATEGORIES: InfoCategory[] = ['feature', 'view', 'highlight']

function isView(view: unknown): view is number {
  return typeof view === 'number' && Number.isInteger(view) && view >= 1 && view <= VIEW_YAWS_DEG.length
}

function toPct(yaw: number): number {
  return (yaw / (2 * Math.PI) + 0.5) * 100
}

// Gemini box_2d ([ymin, xmin, ymax, xmax], 0-1000 in a view) → panorama position + apparent size
function boxToPoint(view: unknown, box: unknown): BoxPoint | null {
  if (!isView(view)) return null
  if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && n >= 0 && n <= 1000)) return null
  const [ymin, xmin, ymax, xmax] = box as number[]
  if (ymax <= ymin || xmax <= xmin) return null
  const cx = (xmin + xmax) / 2
  const { yaw, pitch } = viewPointToYawPitch(view - 1, cx, (ymin + ymax) / 2)
  const top    = viewPointToYawPitch(view - 1, cx, ymin).pitch
  const bottom = viewPointToYawPitch(view - 1, cx, ymax).pitch
  return {
    position_pct: toPct(yaw),
    pitch_deg:    pitch / DEG_TO_RAD,
    size_deg:     (top - bottom) / DEG_TO_RAD,
  }
}

// Overlapping views can yield the same object twice — keep the first (best-ranked) one
function dedupeByAngle<T extends { position_pct: number; pitch_deg: number }>(items: T[]): T[] {
  const kept: T[] = []
  for (const it of items) {
    const yaw = pctToYawRad(it.position_pct), pitch = it.pitch_deg * DEG_TO_RAD
    const dup = kept.some(k =>
      angularDist(pctToYawRad(k.position_pct), yaw) < DEDUP_MIN_ANGLE_RAD &&
      Math.abs(k.pitch_deg * DEG_TO_RAD - pitch) < DEDUP_MIN_ANGLE_RAD,
    )
    if (!dup) kept.push(it)
  }
  return kept
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

async function callGemini(
  thumbnailUrl: string,
  sceneContext: string,
  apiKey:       string,
  existingIds:  Set<string>,
): Promise<SceneAnalysis> {
  const views = await renderPanoViews(thumbnailUrl)

  const parts: GeminiPart[] = [
    { text: STATIC_INSTRUCTION },
    { text: sceneContext },
  ]
  for (const v of views) {
    parts.push({ text: `View ${v.index + 1}:` })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: v.jpegB64 } })
  }

  const text = await generateGemini({ apiKey, parts, json: true })

  let parsed: any
  try {
    parsed = parseGeminiJson(text)
  } catch {
    return { ...EMPTY_ANALYSIS, model_used: GEMINI_MODEL }
  }

  const doorways: Doorway[] = Array.isArray(parsed.doorways)
    ? parsed.doorways.flatMap((d: any) => {
        const pt = boxToPoint(d.view, d.box_2d)
        if (!pt || typeof d.confidence !== 'number' || d.confidence < CONFIDENCE_THRESHOLD) return []
        return [{
          ...pt,
          kind:       DOORWAY_KINDS.includes(d.kind) ? d.kind : 'door',
          leads_to:   cleanText(d.leads_to, 40),
          confidence: d.confidence,
        }]
      })
    : []

  const infoHotspots: InfoHotspot[] = Array.isArray(parsed.info_hotspots)
    ? parsed.info_hotspots.flatMap((h: any) => {
        const pt    = boxToPoint(h.view, h.box_2d)
        const label = cleanText(h.label, 60)
        if (!pt || !label) return []
        return [{
          ...pt,
          category:    INFO_CATEGORIES.includes(h.category) ? h.category : 'feature',
          label,
          description: cleanText(h.description, 500),
        }]
      })
    : []
  // At most one highlight — demote any extras to plain features
  let highlightSeen = false
  for (const h of infoHotspots) {
    if (h.category !== 'highlight') continue
    if (highlightSeen) h.category = 'feature'
    highlightSeen = true
  }

  const removeIds: string[] = Array.isArray(parsed.remove_ids)
    ? parsed.remove_ids.filter((id: any) => typeof id === 'string' && existingIds.has(id))
    : []

  const fixes: HotspotFix[] = Array.isArray(parsed.fix_hotspots)
    ? parsed.fix_hotspots.flatMap((f: any) => {
        if (typeof f?.id !== 'string' || !existingIds.has(f.id) || removeIds.includes(f.id)) return []
        const pt    = boxToPoint(f.view, f.box_2d)
        const label = cleanText(f.label, 60)
        if (!pt && !label) return []
        return [{
          id: f.id,
          ...(pt ? { position_pct: pt.position_pct, pitch_deg: pt.pitch_deg } : {}),
          ...(label ? { label } : {}),
        }]
      })
    : []

  const sv = parsed.start_view
  const startViewPct = isView(sv?.view) && typeof sv?.x === 'number' && sv.x >= 0 && sv.x <= 1000
    ? toPct(viewPointToYawPitch(sv.view - 1, sv.x, 500).yaw)
    : null

  return {
    room_type: typeof parsed.room_type === 'string'
      ? parsed.room_type.toLowerCase().trim()
      : 'room',
    new_name:       cleanText(parsed.new_name, 100),
    doorways:       dedupeByAngle(doorways.sort((a, b) => b.confidence - a.confidence)),
    // Highlights first so they survive the cap
    info_hotspots:  dedupeByAngle(infoHotspots.sort((a, b) =>
      Number(b.category === 'highlight') - Number(a.category === 'highlight'))).slice(0, 3),
    remove_ids:     removeIds,
    fixes,
    start_view_pct: startViewPct,
    group:          cleanText(parsed.group, 40),
    model_used:     GEMINI_MODEL,
  }
}

// ── Coordinate helpers ─────────────────────────────────────────────────────
function titleCase(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Stairs read better with direction: "Up to Bedroom", "Down to Lounge"
function navLabel(targetLabel: string, door: Doorway | null): string {
  if (door?.kind === 'stairs_up')   return `Up to ${targetLabel}`
  if (door?.kind === 'stairs_down') return `Down to ${targetLabel}`
  return targetLabel
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
  icon: string; scale: number
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
          icon:               NAV_ICON,
          scale:              1,
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
          icon:               NAV_ICON,
          scale:              1,
        })
        outgoing.get(source.id)?.add(scene.id)
        incoming.get(scene.id)?.add(source.id)
      }
    }
  }

  return extra
}

// ── Route ──────────────────────────────────────────────────────────────────

// Duplicated from index.ts to handle CORS in this hijacked route
function normalizeOriginPattern(value: string): string {
  return value.trim().toLowerCase()
}

function isOriginAllowed(origin: string, patterns: string[]): boolean {
  const normalizedOrigin = normalizeOriginPattern(origin)
  return patterns.some((pattern) => {
    if (!pattern) return false
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return regex.test(normalizedOrigin)
    }
    return normalizedOrigin === pattern
  })
}

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://viewora.software',
  'https://app.viewora.software',
  'https://*.vercel.app',
].map(normalizeOriginPattern)

const configuredCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(normalizeOriginPattern).filter(Boolean)
  : defaultCorsOrigins


export default async function (fastify: FastifyInstance) {
  fastify.post('/spaces/:spaceId/auto-link', {
    preHandler: [fastify.authenticate],
    config:     { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return reply.code(503).send({
        statusMessage: 'AI auto-link requires GEMINI_API_KEY to be configured on the server.',
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
      .select('id, name, thumbnail_url, order_index, captured_at, initial_yaw, initial_pitch, group_name')
      .eq('space_id', params.spaceId)
      .eq('status', 'ready')
      .order('captured_at', { ascending: true, nullsFirst: false })
      .order('order_index', { ascending: true })
      .limit(MAX_SCENES)

    if (scenesErr || !scenes?.length)
      return reply.code(400).send({ statusMessage: 'No ready scenes found for this tour.' })
    if (scenes.length < 2)
      return reply.code(400).send({ statusMessage: 'You need at least 2 ready scenes to auto-link.' })

    // One auto-link run = one AI request against the plan's monthly allowance
    let refundAi: () => Promise<void>
    try {
      refundAi = await consumeAi(fastify, userId, 'prompts')
    } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }

    // ── Switch to SSE streaming ────────────────────────────────────────────
    // Takes over the raw socket so Fastify's onSend hooks don't interfere.
    // The connection stays alive as long as we write events — Railway never
    // times out a streaming response that is actively sending data.
    reply.hijack()
    const raw = reply.raw
    const origin = req.headers.origin

    const headers: Record<string, string | number> = {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx/Railway proxy buffering
    }

    if (origin && isOriginAllowed(origin, configuredCorsOrigins)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Credentials'] = 'true'
    }

    raw.writeHead(200, headers)

    let clientGone = false
    raw.on('close', () => { clientGone = true })
    raw.on('error', () => { clientGone = true })

    const sendEvent = (event: string, data: object) => {
      if (clientGone) return
      try { raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
      catch { clientGone = true }
    }

    try {
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
        if (clientGone) break

        const scene = scenes[i]

        // Stream progress before analysing each scene so the connection stays
        // active and the frontend can show which scene is being processed.
        sendEvent('progress', {
          sceneIndex: i + 1,
          total:      scenes.length,
          sceneName:  scene.name || `Scene ${i + 1}`,
        })

        if (!scene.thumbnail_url) {
          analyses.push({ sceneId: scene.id, ...EMPTY_ANALYSIS, model_used: 'none' })
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
          sceneGroup:       scene.group_name || null,
          prevSceneName:    i > 0               ? (scenes[i - 1].name || null) : null,
          nextSceneName:    i < scenes.length-1 ? (scenes[i + 1].name || null) : null,
          existingHotspots: existing,
        })

        try {
          const result = await callGemini(scene.thumbnail_url, context, apiKey, new Set(existing.map(h => h.id)))
          analyses.push({ sceneId: scene.id, ...result })
          fastify.log.info({
            sceneId:      scene.id,
            room_type:    result.room_type,
            new_name:     result.new_name,
            doorways:     result.doorways.length,
            info_hs:      result.info_hotspots.length,
            remove_count: result.remove_ids.length,
            fix_count:    result.fixes.length,
            model_used:   result.model_used,
          }, '[autolink] scene analysed')
        } catch (err: any) {
          fastify.log.warn({ err: err.message, sceneId: scene.id }, '[autolink] scene analysis failed')
          analyses.push({ sceneId: scene.id, ...EMPTY_ANALYSIS, model_used: 'error' })
        }

        if (i < scenes.length - 1) await new Promise(r => setTimeout(r, 250))
      }

    // Nothing came back at all (quota/outage) — don't charge the run
    if (analyses.every(a => a.model_used === 'error' || a.model_used === 'none')) await refundAi().catch(() => {})

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    // ── Navigation hotspot suggestions ─────────────────────────────────────
    const rawNav: Array<{
      fromSceneId: string; fromSceneName: string
      toSceneId:   string; toSceneName:   string
      yaw: number; pitch: number
      confidence_hint: number
      label: string; doorwayDescription: string
      icon: string; scale: number
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
          label: navLabel(labelB, doorAB), doorwayDescription: doorAB?.leads_to ?? `Leads to ${labelB}`,
          icon: NAV_ICON, scale: doorAB ? scaleFor(doorAB.size_deg, 'nav') : 1,
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
          label: navLabel(labelA, doorBA), doorwayDescription: doorBA?.leads_to ?? `Back to ${labelA}`,
          icon: NAV_ICON, scale: doorBA ? scaleFor(doorBA.size_deg, 'nav') : 1,
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
        category:   h.category,
        icon:       INFO_ICON[h.category],
        scale:      scaleFor(h.size_deg, 'info'),
        labelBold:  h.category === 'highlight',
      }))
    })

    // ── Fixes to existing hotspots (move / relabel) ─────────────────────────
    const MIN_MOVE_RAD = 3 * DEG_TO_RAD   // smaller nudges aren't worth a review row
    const hotspotFixes = analyses.flatMap(a =>
      a.fixes.flatMap(f => {
        const h = (allHotspots ?? []).find((x: any) => x.id === f.id) as any
        if (!h) return []
        const fix: Record<string, any> = {}
        if (f.position_pct != null && f.pitch_deg != null) {
          const yaw   = pctToYawRad(f.position_pct)
          const pitch = f.pitch_deg * DEG_TO_RAD
          const moved = Math.hypot(angularDist(yaw, Number(h.yaw || 0)), pitch - Number(h.pitch || 0))
          if (moved >= MIN_MOVE_RAD) {
            fix.yaw     = parseFloat(yaw.toFixed(4))
            fix.pitch   = parseFloat(pitch.toFixed(4))
            fix.moveDeg = Math.round(moved / DEG_TO_RAD)
          }
        }
        if (f.label && f.label !== (h.label || '')) fix.newLabel = f.label
        if (!Object.keys(fix).length) return []
        return [{
          _id:       `fix_${f.id}`,
          hotspotId: f.id,
          sceneId:   h.scene_id,
          sceneName: scenes.find(s => s.id === h.scene_id)?.name || '',
          label:     h.label || (h.type === 'scene_link' ? 'Navigation' : 'Info'),
          type:      h.type,
          ...fix,
        }]
      }),
    )

    // ── Scene settings: opening view + category ─────────────────────────────
    // Only fills what the owner hasn't set, so a hand-picked start view is never overridden.
    const sceneSettings = scenes.flatMap(s => {
      const a = byId[s.id]
      if (!a) return []
      const setting: Record<string, any> = {}
      const hasStartView = Number(s.initial_yaw || 0) !== 0 || Number(s.initial_pitch || 0) !== 0
      if (!hasStartView && a.start_view_pct != null) {
        // scenes.initial_yaw is stored in DEGREES (see viewora-app domain/scene resolveStartView)
        const yawDeg = Math.round(pctToYawRad(a.start_view_pct) / DEG_TO_RAD)
        if (yawDeg !== 0) setting.initialYawDeg = yawDeg
      }
      if (!s.group_name && a.group && a.group.toLowerCase() !== 'other') setting.group = a.group
      if (!Object.keys(setting).length) return []
      return [{ _id: `set_${s.id}`, sceneId: s.id, sceneName: s.name || '', ...setting }]
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

      sendEvent('complete', {
        suggestions,
        infoHotspots,
        hotspotDeletions,
        hotspotFixes,
        sceneRenames,
        sceneSettings,
        sceneCount: scenes.length,
      })
    } catch (err: any) {
      fastify.log.error({ err: err.message }, '[autolink] fatal error during SSE stream')
      sendEvent('error', { message: err.message || 'Analysis failed unexpectedly.' })
    } finally {
      raw.end()
    }
  })
}
