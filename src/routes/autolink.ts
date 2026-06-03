import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES           = 20
const CONFIDENCE_THRESHOLD = 58    // discard anything below this
const DEG_TO_RAD           = Math.PI / 180
const DEFAULT_PITCH_RAD    = -8 * DEG_TO_RAD   // ≈ -0.14 rad — typical door threshold
const DEDUP_MIN_ANGLE_RAD  = 0.18  // ~10° — two hotspots closer than this = duplicate

const MODEL_FAST     = 'claude-haiku-4-5-20251001'
const MODEL_ACCURATE = 'claude-sonnet-4-6'

type Doorway = {
  position_pct: number
  pitch_deg:    number
  leads_to:     string
  confidence:   number
}
type SceneAnalysis = {
  room_type:  string
  new_name:   string       // suggested rename; empty string = keep current name
  doorways:   Doorway[]
  model_used: string
}

// ── Room-type vocabulary per property type ─────────────────────────────────
// Giving Claude a constrained vocabulary for the specific building type makes
// naming far more accurate — it can't invent generic labels when precise ones exist.
const ROOM_VOCAB: Record<string, string> = {
  residential:  'bedroom, master bedroom, kids bedroom, bathroom, en-suite bathroom, kitchen, living room, dining room, study, home office, hallway, entrance hall, laundry room, storage room, garage, garden, balcony, staircase',
  commercial:   'open office, private office, executive office, meeting room, conference room, boardroom, reception, lobby, corridor, server room, break room, kitchen, bathroom, staircase, storage room, print room',
  hospitality:  'standard room, deluxe room, suite, lobby, reception, restaurant, bar, gym, spa, pool area, corridor, conference room, meeting room, business centre, rooftop',
  education:    'classroom, lecture hall, laboratory, library, computer lab, staffroom, principal office, reception, corridor, gymnasium, canteen, storage room, toilet',
  automotive:   'showroom, service bay, reception, waiting area, parts room, detail bay, office, toilet, wash bay',
  other:        'room, space, area, corridor, entrance, outdoor area',
}

// ── Static cached instruction — identical for every call ───────────────────
// Marked with cache_control so Anthropic charges only 10% for this block
// on all calls after the first in a 5-minute window.
const STATIC_INSTRUCTION = [
  '<role>',
  'You are a precision spatial analysis engine for a 360° virtual tour platform.',
  'Your two jobs: (1) identify every walkable doorway in the panorama with sub-degree accuracy,',
  'and (2) suggest a precise, human-friendly name for this scene.',
  '</role>',
  '',
  '<projection>',
  'The image is EQUIRECTANGULAR (2:1 aspect ratio):',
  '• Horizontal axis: 0% = far-left edge (directly behind the camera, left side)',
  '                   50% = directly in front of the camera (image centre)',
  '                  100% = far-right edge (directly behind the camera, right side)',
  '• LEFT EDGE and RIGHT EDGE are the SAME physical point. A door at 2% and 98% is ONE door.',
  '• Vertical axis: top edge = ceiling | vertical centre = eye level | bottom edge = floor',
  '• Distortion increases toward top and bottom. Objects near vertical centre are least distorted.',
  '• A door spanning left-right across the image wraps — estimate its TRUE centre position.',
  '</projection>',
  '',
  '<doorway_rules>',
  'INCLUDE as a doorway:',
  '  • Open doorways (door removed or fully open)',
  '  • Open archways leading to another room',
  '  • Open corridors or passageways',
  '  • Open sliding doors, open double doors',
  '',
  'EXCLUDE — do NOT count:',
  '  • Any closed door (even partially closed)',
  '  • Windows (no matter how large)',
  '  • Mirrors (reflect the same room — common trap)',
  '  • Decorative arches with no room behind',
  '  • Glass partitions without an opening',
  '  • Dark areas where no opening is visible',
  '  • The same physical opening detected twice from different parts of the image',
  '</doorway_rules>',
  '',
  '<precision_guide>',
  'position_pct: Mark the GEOMETRIC CENTRE of the doorway opening (not the door frame).',
  '  — A door at the left edge of a room = ~10–20%.',
  '  — A door dead-centre = 50%.',
  '  — A narrow door off-centre right = ~60–70%.',
  '  — Be precise to ±2 percentage points.',
  '',
  'pitch_deg: The vertical angle to the MIDDLE HEIGHT of the doorway opening.',
  '  — Standard door at eye level: -5 to -12 degrees.',
  '  — Door viewed from below (camera tilted up): can be 0 to +8 degrees.',
  '  — Door viewed from above (camera tilted down): can be -15 to -25 degrees.',
  '  — Do NOT use values outside -30 to +15 unless extreme tilt is obvious.',
  '',
  'confidence:',
  '  90–100 = crystal-clear open doorway, unambiguous',
  '  75–89  = clearly a passage, minor uncertainty about exact position',
  '  60–74  = probable doorway, some occlusion or partial view',
  '  Below 58 = omit entirely — too uncertain',
  '</precision_guide>',
  '',
  '<output_format>',
  'Return ONLY valid compact JSON, zero markdown, zero explanation:',
  '{"room_type":"<type>","new_name":"<suggested name or empty string>","doorways":[{"position_pct":<int>,"pitch_deg":<int>,"leads_to":"<1-3 words>","confidence":<int>}]}',
  '',
  'new_name rules:',
  '  — Use the allowed vocabulary for this property type (provided in context).',
  '  — Return empty string "" if current name is already correct.',
  '  — Be specific: "master bedroom" not "bedroom" when it clearly has an en-suite.',
  '  — For outdoor scenes: "garden", "balcony", "rooftop", etc.',
  '</output_format>',
].join('\n')

// ── Per-scene context (NOT cached — changes per scene) ─────────────────────
function buildSceneContext(opts: {
  spaceTitle:    string
  spaceType:     string
  locationText:  string
  totalScenes:   number
  sceneIndex:    number
  sceneName:     string
  prevSceneName: string | null
  nextSceneName: string | null
}): string {
  const vocab = ROOM_VOCAB[opts.spaceType] || ROOM_VOCAB.other
  const lines = [
    '<scene_context>',
    `Property: "${opts.spaceTitle}" — type: ${opts.spaceType}${opts.locationText ? ` — location: ${opts.locationText}` : ''}`,
    `This is scene ${opts.sceneIndex + 1} of ${opts.totalScenes} in the tour.`,
    `Current scene name: "${opts.sceneName}"`,
  ]
  if (opts.prevSceneName) lines.push(`Previous scene: "${opts.prevSceneName}"`)
  if (opts.nextSceneName) lines.push(`Next scene: "${opts.nextSceneName}"`)
  lines.push(`Allowed room_type and new_name vocabulary: ${vocab}`)
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
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: [
          // Block 1: static instruction — cached after first call
          {
            type:          'text',
            text:          STATIC_INSTRUCTION,
            cache_control: { type: 'ephemeral' },
          },
          // Block 2: per-scene context — NOT cached (changes each call)
          {
            type: 'text',
            text: sceneContext,
          },
          // Block 3: the panorama — Claude fetches from CDN directly (no base64 overhead)
          {
            type:   'image',
            source: { type: 'url', url: thumbnailUrl },
          },
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
      new_name: typeof parsed.new_name === 'string'
        ? parsed.new_name.trim()
        : '',
      doorways: Array.isArray(parsed.doorways)
        ? parsed.doorways
            .filter((d: any) =>
              typeof d.position_pct === 'number' &&
              typeof d.pitch_deg    === 'number' &&
              typeof d.confidence   === 'number' &&
              d.position_pct >= 0 && d.position_pct <= 100 &&
              d.confidence   >= CONFIDENCE_THRESHOLD,
            )
            // Sort by confidence desc so we always use the best detection first
            .sort((a: any, b: any) => b.confidence - a.confidence)
        : [],
      model_used: model,
    }
  } catch {
    return { room_type: 'room', new_name: '', doorways: [], model_used: model }
  }
}

// ── Two-tier analysis: Haiku first, Sonnet on uncertain scenes ─────────────
async function analyzeScene(
  thumbnailUrl: string,
  sceneContext: string,
  apiKey:       string,
): Promise<SceneAnalysis> {
  const fast = await callClaude(thumbnailUrl, sceneContext, apiKey, MODEL_FAST)

  const maxConf = fast.doorways.length
    ? Math.max(...fast.doorways.map(d => d.confidence))
    : 0

  // Accept Haiku result only if at least one doorway is high-confidence
  if (fast.doorways.length > 0 && maxConf >= 70) return fast

  // Upgrade to Sonnet for ambiguous / doorway-less scenes
  try {
    const accurate = await callClaude(thumbnailUrl, sceneContext, apiKey, MODEL_ACCURATE)
    return {
      room_type:  accurate.room_type !== 'room' ? accurate.room_type : fast.room_type,
      new_name:   accurate.new_name  || fast.new_name,
      doorways:   accurate.doorways.length > 0  ? accurate.doorways  : fast.doorways,
      model_used: `${MODEL_FAST}+${MODEL_ACCURATE}`,
    }
  } catch {
    return fast
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

// Angular distance on a circle (accounts for wrap-around)
function angularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

function findMatchingDoorway(doorways: Doorway[], targetRoomType: string): Doorway | null {
  if (!doorways.length) return null
  const target = targetRoomType.toLowerCase()
  const exact  = doorways.find(d =>
    d.leads_to.toLowerCase().includes(target) ||
    target.includes(d.leads_to.toLowerCase()),
  )
  if (exact) return exact
  // Fall back to highest-confidence doorway
  return doorways[0]  // already sorted by confidence desc
}

// ── Global deduplication ───────────────────────────────────────────────────
// Removes hotspots that are too close together from the same source scene.
// This prevents the "two arrows in the same place" bug that occurs when:
//   - The AI detects the same physical opening twice (from different image angles)
//   - The forward and extra-exit pass create overlapping suggestions
function deduplicate(
  suggestions: Array<{
    fromSceneId: string; toSceneId: string
    yaw: number; pitch: number
    confidence_hint: number
    label: string; doorwayDescription: string
    fromSceneName: string; toSceneName: string
  }>,
): typeof suggestions {
  const result: typeof suggestions = []

  for (const s of suggestions) {
    // Check if a spatially similar hotspot from the same source scene already exists
    const isDuplicate = result.some(r =>
      r.fromSceneId === s.fromSceneId &&
      angularDist(r.yaw, s.yaw) < DEDUP_MIN_ANGLE_RAD,
    )
    if (!isDuplicate) result.push(s)
  }

  return result
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

    // Fetch space including type and location for AI context
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id, title, property_type, location_text')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    const spaceType     = (space.property_type || 'other') as string
    const spaceTitle    = (space.title          || 'Property') as string
    const locationText  = (space.location_text  || '') as string

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

    // Existing links — skip pairs already linked
    const sceneIds = scenes.map(s => s.id)
    const { data: existingLinks } = await fastify.supabase
      .from('hotspots')
      .select('scene_id, target_scene_id')
      .in('scene_id', sceneIds)
      .eq('type', 'scene_link')
    const linkedPairs = new Set<string>(
      (existingLinks ?? [])
        .filter((h: any) => h.target_scene_id)
        .map((h: any) => `${h.scene_id}:${h.target_scene_id}`),
    )

    // ── Analyse all scenes ─────────────────────────────────────────────────
    const analyses: Array<{ sceneId: string } & SceneAnalysis> = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      if (!scene.thumbnail_url) {
        analyses.push({ sceneId: scene.id, room_type: 'room', new_name: '', doorways: [], model_used: 'none' })
        continue
      }

      const context = buildSceneContext({
        spaceTitle,
        spaceType,
        locationText,
        totalScenes:   scenes.length,
        sceneIndex:    i,
        sceneName:     scene.name || `Scene ${i + 1}`,
        prevSceneName: i > 0                  ? (scenes[i - 1].name || null) : null,
        nextSceneName: i < scenes.length - 1  ? (scenes[i + 1].name || null) : null,
      })

      try {
        const result = await analyzeScene(scene.thumbnail_url, context, apiKey)
        analyses.push({ sceneId: scene.id, ...result })
        fastify.log.info({
          sceneId:    scene.id,
          room_type:  result.room_type,
          new_name:   result.new_name,
          doorways:   result.doorways.length,
          model_used: result.model_used,
        }, '[autolink] scene analysed')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, sceneId: scene.id }, '[autolink] scene analysis failed')
        analyses.push({ sceneId: scene.id, room_type: 'room', new_name: '', doorways: [], model_used: 'error' })
      }

      await new Promise(r => setTimeout(r, 200))
    }

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    // ── Build raw suggestions ──────────────────────────────────────────────
    const raw: Array<{
      fromSceneId: string; fromSceneName: string
      toSceneId:   string; toSceneName:   string
      yaw: number; pitch: number
      confidence_hint: number
      label: string; doorwayDescription: string
    }> = []

    for (let i = 0; i < scenes.length - 1; i++) {
      const a = scenes[i]
      const b = scenes[i + 1]
      const analysisA = byId[a.id]
      const analysisB = byId[b.id]
      const labelB = titleCase(analysisB?.room_type || b.name)
      const labelA = titleCase(analysisA?.room_type || a.name)

      // Forward: A → B
      if (!linkedPairs.has(`${a.id}:${b.id}`)) {
        const doorAB  = findMatchingDoorway(analysisA?.doorways ?? [], analysisB?.room_type ?? '')
        const yawAB   = doorAB ? pctToYawRad(doorAB.position_pct) : 0
        const pitchAB = doorAB ? doorAB.pitch_deg * DEG_TO_RAD    : DEFAULT_PITCH_RAD

        raw.push({
          fromSceneId: a.id, fromSceneName: a.name,
          toSceneId:   b.id, toSceneName:   b.name,
          yaw:   parseFloat(yawAB.toFixed(4)),
          pitch: parseFloat(pitchAB.toFixed(4)),
          confidence_hint: doorAB?.confidence ?? 50,
          label: labelB,
          doorwayDescription: doorAB?.leads_to ?? `Leads to ${labelB}`,
        })
      }

      // Backward: B → A
      if (!linkedPairs.has(`${b.id}:${a.id}`)) {
        const doorBA  = findMatchingDoorway(analysisB?.doorways ?? [], analysisA?.room_type ?? '')
        // If the AI found the matching doorway use it; otherwise estimate the opposite
        // direction of the forward hotspot as the best guess for where to return from.
        const yawBA   = doorBA
          ? pctToYawRad(doorBA.position_pct)
          : oppositeYawRad(raw.find(s => s.fromSceneId === a.id && s.toSceneId === b.id)?.yaw ?? 0)
        const pitchBA = doorBA ? doorBA.pitch_deg * DEG_TO_RAD : DEFAULT_PITCH_RAD

        raw.push({
          fromSceneId: b.id, fromSceneName: b.name,
          toSceneId:   a.id, toSceneName:   a.name,
          yaw:   parseFloat(yawBA.toFixed(4)),
          pitch: parseFloat(pitchBA.toFixed(4)),
          confidence_hint: doorBA?.confidence ?? 50,
          label: labelA,
          doorwayDescription: doorBA?.leads_to ?? `Back to ${labelA}`,
        })
      }
    }

    // ── Global spatial deduplication ───────────────────────────────────────
    // Sort high-confidence first so the best detection survives dedup
    raw.sort((a, b) => b.confidence_hint - a.confidence_hint)
    const suggestions = deduplicate(raw).map(({ confidence_hint: _c, ...s }) => s)

    // ── Scene rename suggestions ───────────────────────────────────────────
    // Suggest a rename whenever:
    //   (a) the scene has a generic "Scene N" name, OR
    //   (b) the AI returned a new_name that differs from the current name
    const sceneRenames = scenes.flatMap(s => {
      const analysis = byId[s.id]
      if (!analysis) return []

      const currentNorm  = (s.name || '').toLowerCase().trim()
      const suggestedRaw = analysis.new_name || analysis.room_type
      const suggested    = titleCase(suggestedRaw)
      const suggestedNorm = suggested.toLowerCase()

      // Skip if AI result is uncertain or matches current name
      if (!suggestedRaw || suggestedRaw === 'room' || suggestedNorm === currentNorm) return []

      // Always rename generic "Scene N" names; also rename when AI is confident of a better name
      const isGeneric = /^scene\s+\d+$/i.test(s.name || '')
      if (isGeneric || analysis.new_name) {
        return [{ sceneId: s.id, currentName: s.name, suggestedName: suggested }]
      }
      return []
    })

    return reply.send({ suggestions, sceneRenames, sceneCount: scenes.length })
  })
}
