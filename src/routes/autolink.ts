import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES = 20
const CONFIDENCE_THRESHOLD = 55   // discard detections Claude is unsure about
const DEG_TO_RAD = Math.PI / 180

// PSV stores coordinates in RADIANS. Convert degrees → radians for all values
// before they reach the DB so manual hotspots (also in radians) stay consistent.
const DEFAULT_PITCH_RAD = -8 * DEG_TO_RAD  // ≈ -0.14 rad — slightly below horizon

type Doorway = {
  position_pct: number  // 0–100 horizontal position in the equirectangular image
  pitch_deg: number     // vertical degrees: negative = below horizon (doors: -5 to -20)
  leads_to: string
  confidence: number    // 0–100 — how certain Claude is this is a real walkable passage
}
type SceneAnalysis = { room_type: string; doorways: Doorway[] }

async function analyzeScene(thumbnailUrl: string, apiKey: string): Promise<SceneAnalysis> {
  const imgRes = await fetch(thumbnailUrl)
  if (!imgRes.ok) throw new Error(`Thumbnail fetch failed: ${imgRes.status}`)
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')

  const prompt = [
    'You are a spatial analysis engine for a 360° virtual tour builder.',
    '',
    'The image is an EQUIRECTANGULAR panorama (2:1 aspect ratio).',
    'It wraps horizontally — the left and right edges are the same physical point behind the camera.',
    'The vertical center (50% height) is the horizon. Top = ceiling, bottom = floor.',
    '',
    'TASK: Identify every physical opening a person could WALK THROUGH to reach another space.',
    'Count: open doorways, open archways, corridors, and passageways.',
    'Do NOT count: windows, mirrors, glass walls, paintings, decorative arches, or closed doors.',
    '',
    'For each walkable opening output:',
    '  position_pct — integer 0–100 marking the HORIZONTAL CENTER of the opening.',
    '    0 = far-left edge of image, 50 = directly in front (image center), 100 = far-right edge.',
    '    Be precise: a door at the left quarter of the image = ~25.',
    '  pitch_deg — integer degrees. Negative = below horizon (where doors sit).',
    '    Typical range for a door threshold viewed straight-on: -5 to -20.',
    '    Only go below -25 if the camera was tilted upward and you can see the floor clearly.',
    '  leads_to — 1–3 word description of the destination space (e.g. "hallway", "bedroom", "outside").',
    '  confidence — integer 0–100. How certain are you this is a real, distinct, WALKABLE opening?',
    '    100 = absolutely clear open door. 70 = probable passage. Below 55 = skip it.',
    '',
    'Also identify the room_type of THIS scene (e.g. "living room", "kitchen", "hallway",',
    '"master bedroom", "bathroom", "entrance hall", "dining room", "office", "balcony", "garden").',
    '',
    'Reply with ONLY valid JSON — no markdown, no explanation, no trailing text:',
    '{"room_type":"string","doorways":[{"position_pct":number,"pitch_deg":number,"leads_to":"string","confidence":number}]}',
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
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
    const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
    const parsed = JSON.parse(clean)
    return {
      room_type: typeof parsed.room_type === 'string' ? parsed.room_type.toLowerCase().trim() : 'room',
      doorways: Array.isArray(parsed.doorways)
        ? parsed.doorways.filter((d: any) =>
            typeof d.position_pct === 'number' &&
            typeof d.pitch_deg    === 'number' &&
            typeof d.confidence   === 'number' &&
            d.position_pct >= 0 && d.position_pct <= 100 &&
            d.confidence >= CONFIDENCE_THRESHOLD,
          )
        : [],
    }
  } catch {
    return { room_type: 'room', doorways: [] }
  }
}

function titleCase(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Convert Claude's equirectangular position_pct to a PSV yaw in RADIANS.
// 0% = far-left = -π, 50% = front-center = 0, 100% = far-right = +π
function pctToYawRad(pct: number): number {
  return (pct / 100 - 0.5) * 2 * Math.PI
}

// Opposite yaw (180° away) — used when the back-doorway is not detected
function oppositeYawRad(yawRad: number): number {
  const flipped = yawRad + Math.PI
  return flipped > Math.PI ? flipped - 2 * Math.PI : flipped
}

// Find the doorway in `doorways` whose `leads_to` best matches `targetRoomType`.
// Returns null if nothing matches well enough to be trusted.
function findMatchingDoorway(doorways: Doorway[], targetRoomType: string): Doorway | null {
  if (!doorways.length) return null
  const target = targetRoomType.toLowerCase()

  // Exact or substring match first
  const exactMatch = doorways.find(d =>
    d.leads_to.toLowerCase().includes(target) ||
    target.includes(d.leads_to.toLowerCase())
  )
  if (exactMatch) return exactMatch

  // Fall back to the highest-confidence doorway
  return doorways.reduce((best, d) => d.confidence > best.confidence ? d : best, doorways[0])
}

export default async function (fastify: FastifyInstance) {
  fastify.post('/spaces/:spaceId/auto-link', {
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: { max: 3, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return reply.code(503).send({ statusMessage: 'AI auto-link requires ANTHROPIC_API_KEY to be configured on this server.' })
    }

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    const { data: scenes, error: scenesErr } = await fastify.supabase
      .from('scenes')
      .select('id, name, thumbnail_url, order_index, captured_at')
      .eq('space_id', params.spaceId)
      .eq('status', 'ready')
      .order('captured_at', { ascending: true, nullsFirst: false })
      .order('order_index', { ascending: true })
      .limit(MAX_SCENES)

    if (scenesErr || !scenes?.length) {
      return reply.code(400).send({ statusMessage: 'No ready scenes found for this tour.' })
    }
    if (scenes.length < 2) {
      return reply.code(400).send({ statusMessage: 'You need at least 2 ready scenes to auto-link.' })
    }

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

    // Analyse each scene with Sonnet — sequential to respect Anthropic rate limits
    const analyses: Array<{ sceneId: string } & SceneAnalysis> = []
    for (const scene of scenes) {
      if (!scene.thumbnail_url) {
        analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [] })
      } else {
        try {
          const result = await analyzeScene(scene.thumbnail_url, apiKey)
          analyses.push({ sceneId: scene.id, ...result })
          fastify.log.info(
            { sceneId: scene.id, room_type: result.room_type, doorways: result.doorways.length },
            '[autolink] scene analysed',
          )
        } catch (err: any) {
          fastify.log.warn({ err: err.message, sceneId: scene.id }, '[autolink] scene analysis failed — using fallback')
          analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [] })
        }
      }
      // 300ms between Sonnet calls (Sonnet is slower than Haiku — gives rate limiter breathing room)
      await new Promise(r => setTimeout(r, 300))
    }

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    const suggestions: Array<{
      fromSceneId: string; fromSceneName: string
      toSceneId: string; toSceneName: string
      yaw: number; pitch: number
      label: string; doorwayDescription: string
    }> = []

    // ── Build hotspot suggestions ────────────────────────────────────────────
    // Strategy:
    //   1. For each scene pair (A, B) — consecutive by capture order — create
    //      forward (A→B) and backward (B→A) hotspots.
    //   2. For forward: pick the highest-confidence doorway in A that plausibly
    //      leads to B (by matching leads_to vs B's room type). Fall back to the
    //      highest-confidence doorway available.
    //   3. For backward: find the doorway in B that leads back to A's room type.
    //      If none, place at the opposite yaw from the forward hotspot.
    //   4. All coordinates stored as RADIANS to match PSV's coordinate system.

    for (let i = 0; i < scenes.length - 1; i++) {
      const a = scenes[i]
      const b = scenes[i + 1]
      const analysisA = byId[a.id]
      const analysisB = byId[b.id]
      const labelB = titleCase(analysisB?.room_type || b.name)
      const labelA = titleCase(analysisA?.room_type || a.name)

      // ── Forward: A → B ──────────────────────────────────────────
      if (!linkedPairs.has(`${a.id}:${b.id}`)) {
        const doorAB = findMatchingDoorway(analysisA?.doorways ?? [], analysisB?.room_type ?? '')
        const yawAB  = doorAB ? pctToYawRad(doorAB.position_pct) : 0
        const pitchAB = doorAB ? doorAB.pitch_deg * DEG_TO_RAD : DEFAULT_PITCH_RAD

        suggestions.push({
          fromSceneId: a.id, fromSceneName: a.name,
          toSceneId:   b.id, toSceneName:   b.name,
          yaw:   parseFloat(yawAB.toFixed(4)),
          pitch: parseFloat(pitchAB.toFixed(4)),
          label: labelB,
          doorwayDescription: doorAB?.leads_to ?? `Leads to ${labelB}`,
        })

        // ── Backward: B → A ──────────────────────────────────────
        if (!linkedPairs.has(`${b.id}:${a.id}`)) {
          const doorBA  = findMatchingDoorway(analysisB?.doorways ?? [], analysisA?.room_type ?? '')
          const yawBA   = doorBA ? pctToYawRad(doorBA.position_pct) : oppositeYawRad(yawAB)
          const pitchBA = doorBA ? doorBA.pitch_deg * DEG_TO_RAD : DEFAULT_PITCH_RAD

          suggestions.push({
            fromSceneId: b.id, fromSceneName: b.name,
            toSceneId:   a.id, toSceneName:   a.name,
            yaw:   parseFloat(yawBA.toFixed(4)),
            pitch: parseFloat(pitchBA.toFixed(4)),
            label: labelA,
            doorwayDescription: doorBA?.leads_to ?? `Back to ${labelA}`,
          })
        }

        // ── Extra doorways in A that weren't used for the main forward link ──
        // If scene A has multiple exits (e.g. a hallway), create additional
        // hotspots for remaining high-confidence doorways pointing to scene B.
        const extraDoorways = (analysisA?.doorways ?? [])
          .filter(d => d !== doorAB && d.confidence >= CONFIDENCE_THRESHOLD + 10)
        for (const extra of extraDoorways) {
          const extraYaw   = pctToYawRad(extra.position_pct)
          const extraPitch = extra.pitch_deg * DEG_TO_RAD
          // Avoid placing two hotspots within 0.3 rad (~17°) of each other in the same scene
          const tooClose = suggestions.some(
            s => s.fromSceneId === a.id && s.toSceneId === b.id &&
              Math.abs(s.yaw - extraYaw) < 0.3,
          )
          if (!tooClose) {
            suggestions.push({
              fromSceneId: a.id, fromSceneName: a.name,
              toSceneId:   b.id, toSceneName:   b.name,
              yaw:   parseFloat(extraYaw.toFixed(4)),
              pitch: parseFloat(extraPitch.toFixed(4)),
              label: labelB,
              doorwayDescription: extra.leads_to,
            })
          }
        }
      }
    }

    // Suggest renaming scenes that still have default "Scene N" names
    const sceneRenames = scenes
      .filter(s => /^scene\s+\d+$/i.test(s.name || ''))
      .flatMap(s => {
        const rt = byId[s.id]?.room_type
        if (!rt || rt === 'room') return []
        const suggested = titleCase(rt)
        if (suggested.toLowerCase() === (s.name || '').toLowerCase()) return []
        return [{ sceneId: s.id, currentName: s.name, suggestedName: suggested }]
      })

    return reply.send({ suggestions, sceneRenames, sceneCount: scenes.length })
  })
}
