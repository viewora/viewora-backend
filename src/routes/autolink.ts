import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES          = 20
const CONFIDENCE_THRESHOLD = 55   // discard detections below this
const DEG_TO_RAD           = Math.PI / 180
const DEFAULT_PITCH_RAD    = -8 * DEG_TO_RAD  // ≈ -0.14 rad — slightly below horizon

// ── Model tier config ──────────────────────────────────────────────────────
// Haiku 4.5  = $1/$5 per 1M tokens  — 97 tokens/sec — used for all scenes first
// Sonnet 4.6 = $3/$15 per 1M tokens — slower         — fallback for hard scenes only
// A two-tier approach keeps costs ~3× lower than Sonnet-only while maintaining
// accuracy: Sonnet only fires when Haiku returns zero doorways or all low-confidence.
const MODEL_FAST     = 'claude-haiku-4-5-20251001'
const MODEL_ACCURATE = 'claude-sonnet-4-6'

type Doorway = {
  position_pct: number   // 0–100 horizontal in equirectangular image
  pitch_deg:    number   // degrees, negative = below horizon
  leads_to:     string
  confidence:   number   // 0–100
}
type SceneAnalysis = { room_type: string; doorways: Doorway[]; model_used: string }

// ── Shared prompt (cached by Anthropic after first call in a 5-min window) ─
// Prompt caching: first call pays full price; all subsequent calls in the
// same auto-link run pay only 10% of input token cost for this text block.
// Placing the static instruction BEFORE the per-scene image lets the API
// cache the text and treat each image as the only fresh input.
const SYSTEM_PROMPT = [
  '<task>',
  'You are a spatial analysis engine embedded in a 360° virtual tour platform.',
  'Your job: analyse an equirectangular panorama and identify every physical',
  'opening a person could WALK THROUGH to reach an adjacent space.',
  '</task>',
  '',
  '<projection_notes>',
  'The image uses EQUIRECTANGULAR (2:1 aspect ratio) projection:',
  '• Horizontal: 0 % = far-left edge (behind camera, left) | 50 % = directly in front | 100 % = far-right edge (behind camera, right)',
  '• The left and right edges ARE the same physical point — they wrap seamlessly.',
  '• Vertical: top = ceiling, bottom = floor, vertical center = horizon (eye level).',
  '• Distortion increases toward top and bottom. Doors near vertical centre are clearest.',
  '• A door spanning the left edge (e.g. 2 %) and right edge (e.g. 98 %) is ONE door behind you.',
  '</projection_notes>',
  '',
  '<what_counts>',
  'COUNT as a walkable opening:',
  '  • Open doorways (door fully open or absent)',
  '  • Open archways leading to another room',
  '  • Corridors and passageways you can walk into',
  '  • Open patio / balcony doors',
  '',
  'DO NOT COUNT:',
  '  • Closed doors (even if you can see the door frame)',
  '  • Windows of any size',
  '  • Mirrors (they reflect the same room)',
  '  • Decorative arches that do not lead anywhere',
  '  • Glass walls or partitions that are not doorways',
  '  • Dark corners where no opening is clearly visible',
  '</what_counts>',
  '',
  '<output_format>',
  'Return ONLY valid compact JSON, no markdown, no explanation:',
  '{"room_type":"<type>","doorways":[{"position_pct":<0-100>,"pitch_deg":<degrees>,"leads_to":"<1-3 words>","confidence":<0-100>}]}',
  '',
  'Fields:',
  '  room_type   — one of: living room, kitchen, bedroom, master bedroom, bathroom,',
  '                hallway, entrance hall, dining room, office, balcony, garden, staircase,',
  '                garage, storage, gym, lobby, corridor. Use "room" only if truly uncertain.',
  '  position_pct — integer 0–100. Be precise to ±3 pts. Mark the geometric CENTER of the opening.',
  '  pitch_deg   — integer degrees. Doors typically sit at -5 to -15 (slightly below eye level).',
  '                Only use values outside -25 to +5 if camera tilt clearly justifies it.',
  '  leads_to    — 1–3 words describing the destination (e.g. "hallway", "master bedroom", "outside").',
  '  confidence  — 0=complete guess, 100=undeniably clear walkable opening.',
  '                70+ = include. 55–69 = include with caution. Below 55 = omit entirely.',
  '</output_format>',
].join('\n')

// ── Core API call ──────────────────────────────────────────────────────────
async function callClaude(
  thumbnailUrl: string,
  apiKey: string,
  model: string,
): Promise<SceneAnalysis> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':           apiKey,
      'anthropic-version':   '2023-06-01',
      'anthropic-beta':      'prompt-caching-2024-07-31',  // enable caching
      'content-type':        'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,   // doorway JSON is always < 300 tokens; cap saves cost
      messages: [{
        role: 'user',
        content: [
          // ① Static instruction — marked for caching. After the first call in a
          //   5-min window Anthropic returns this at 10% of normal input token cost.
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
          // ② Per-scene image — sent as URL so the server never downloads it.
          //   Claude fetches the CDN thumbnail directly, saving bandwidth & latency.
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
      doorways: Array.isArray(parsed.doorways)
        ? parsed.doorways.filter((d: any) =>
            typeof d.position_pct === 'number' &&
            typeof d.pitch_deg    === 'number' &&
            typeof d.confidence   === 'number' &&
            d.position_pct >= 0 && d.position_pct <= 100 &&
            d.confidence   >= CONFIDENCE_THRESHOLD,
          )
        : [],
      model_used: model,
    }
  } catch {
    return { room_type: 'room', doorways: [], model_used: model }
  }
}

// ── Two-tier scene analysis ────────────────────────────────────────────────
// 1. Try Haiku (fast, cheap). If it returns confident results → done.
// 2. If Haiku finds nothing or all low-confidence → retry with Sonnet.
//    Haiku handles ~90 % of scenes; Sonnet only fires for ambiguous cases.
async function analyzeScene(thumbnailUrl: string, apiKey: string): Promise<SceneAnalysis> {
  const fast = await callClaude(thumbnailUrl, apiKey, MODEL_FAST)

  const maxConf = fast.doorways.length
    ? Math.max(...fast.doorways.map(d => d.confidence))
    : 0

  // Use Haiku result if: ≥1 doorway found AND top confidence ≥ 65
  if (fast.doorways.length > 0 && maxConf >= 65) return fast

  // Otherwise upgrade to Sonnet for a second opinion on this scene
  try {
    const accurate = await callClaude(thumbnailUrl, apiKey, MODEL_ACCURATE)
    // Merge: keep Sonnet's doorways; use its room_type if Haiku was uncertain
    return {
      room_type:  accurate.room_type !== 'room' ? accurate.room_type : fast.room_type,
      doorways:   accurate.doorways.length > 0  ? accurate.doorways  : fast.doorways,
      model_used: `${MODEL_FAST}+${MODEL_ACCURATE}`,
    }
  } catch {
    return fast  // Sonnet failed — use whatever Haiku had
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
  const flipped = yawRad + Math.PI
  return flipped > Math.PI ? flipped - 2 * Math.PI : flipped
}

function findMatchingDoorway(doorways: Doorway[], targetRoomType: string): Doorway | null {
  if (!doorways.length) return null
  const target = targetRoomType.toLowerCase()

  const exactMatch = doorways.find(d =>
    d.leads_to.toLowerCase().includes(target) ||
    target.includes(d.leads_to.toLowerCase()),
  )
  if (exactMatch) return exactMatch

  return doorways.reduce((best, d) => d.confidence > best.confidence ? d : best, doorways[0])
}

// ── Route ──────────────────────────────────────────────────────────────────
export default async function (fastify: FastifyInstance) {
  fastify.post('/spaces/:spaceId/auto-link', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
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

    if (scenesErr || !scenes?.length)
      return reply.code(400).send({ statusMessage: 'No ready scenes found for this tour.' })
    if (scenes.length < 2)
      return reply.code(400).send({ statusMessage: 'You need at least 2 ready scenes to auto-link.' })

    // Fetch existing links to avoid duplicates
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

    // ── Analyse scenes sequentially ──────────────────────────────────────
    // Sequential (not parallel) to respect Anthropic's per-minute token limits.
    // 200 ms delay between calls; the prompt cache warms on the first call so
    // subsequent calls are fast (cache hit latency ~100 ms vs ~800 ms cold).
    const analyses: Array<{ sceneId: string } & SceneAnalysis> = []

    for (const scene of scenes) {
      if (!scene.thumbnail_url) {
        analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [], model_used: 'none' })
      } else {
        try {
          const result = await analyzeScene(scene.thumbnail_url, apiKey)
          analyses.push({ sceneId: scene.id, ...result })
          fastify.log.info(
            {
              sceneId:    scene.id,
              room_type:  result.room_type,
              doorways:   result.doorways.length,
              model_used: result.model_used,
            },
            '[autolink] scene analysed',
          )
        } catch (err: any) {
          fastify.log.warn(
            { err: err.message, sceneId: scene.id },
            '[autolink] scene analysis failed — using fallback',
          )
          analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [], model_used: 'error' })
        }
      }
      await new Promise(r => setTimeout(r, 200))
    }

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    // ── Build hotspot suggestions ─────────────────────────────────────────
    const suggestions: Array<{
      fromSceneId:        string; fromSceneName: string
      toSceneId:          string; toSceneName:   string
      yaw:                number; pitch: number
      label:              string; doorwayDescription: string
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
        const doorAB   = findMatchingDoorway(analysisA?.doorways ?? [], analysisB?.room_type ?? '')
        const yawAB    = doorAB ? pctToYawRad(doorAB.position_pct) : 0
        const pitchAB  = doorAB ? doorAB.pitch_deg * DEG_TO_RAD   : DEFAULT_PITCH_RAD

        suggestions.push({
          fromSceneId: a.id, fromSceneName: a.name,
          toSceneId:   b.id, toSceneName:   b.name,
          yaw:   parseFloat(yawAB.toFixed(4)),
          pitch: parseFloat(pitchAB.toFixed(4)),
          label: labelB,
          doorwayDescription: doorAB?.leads_to ?? `Leads to ${labelB}`,
        })

        // Backward: B → A
        if (!linkedPairs.has(`${b.id}:${a.id}`)) {
          const doorBA  = findMatchingDoorway(analysisB?.doorways ?? [], analysisA?.room_type ?? '')
          const yawBA   = doorBA ? pctToYawRad(doorBA.position_pct) : oppositeYawRad(yawAB)
          const pitchBA = doorBA ? doorBA.pitch_deg * DEG_TO_RAD    : DEFAULT_PITCH_RAD

          suggestions.push({
            fromSceneId: b.id, fromSceneName: b.name,
            toSceneId:   a.id, toSceneName:   a.name,
            yaw:   parseFloat(yawBA.toFixed(4)),
            pitch: parseFloat(pitchBA.toFixed(4)),
            label: labelA,
            doorwayDescription: doorBA?.leads_to ?? `Back to ${labelA}`,
          })
        }

        // Extra exits in A (hallways, rooms with multiple doors)
        const extras = (analysisA?.doorways ?? [])
          .filter(d => d !== doorAB && d.confidence >= CONFIDENCE_THRESHOLD + 10)
        for (const extra of extras) {
          const extraYaw   = pctToYawRad(extra.position_pct)
          const extraPitch = extra.pitch_deg * DEG_TO_RAD
          const tooClose   = suggestions.some(
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

    // Scene rename suggestions for default "Scene N" names
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
