import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

const MAX_SCENES = 20
const DEFAULT_PITCH = -8  // degrees — slightly below horizon (typical door position)

type Doorway = { position_pct: number; leads_to: string }
type SceneAnalysis = { room_type: string; doorways: Doorway[] }

async function analyzeScene(thumbnailUrl: string, apiKey: string): Promise<SceneAnalysis> {
  const imgRes = await fetch(thumbnailUrl)
  if (!imgRes.ok) throw new Error(`Thumbnail fetch failed: ${imgRes.status}`)
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')

  const prompt =
    'You are analyzing a 360° panoramic room photograph (equirectangular projection, 2:1 ratio). ' +
    'The image wraps horizontally — left and right edges connect.\n\n' +
    'Identify:\n' +
    '1. The room type (e.g. "living room", "bedroom", "kitchen", "hallway", "bathroom", "entrance", "garden", "office")\n' +
    '2. All visible doorways, open archways, passages, or corridors that lead to adjacent spaces\n\n' +
    'For each opening estimate its center as an integer percentage from the left edge ' +
    '(0 = far-left, 50 = center, 100 = far-right).\n\n' +
    'Reply with JSON only, no explanation:\n' +
    '{"room_type":"string","doorways":[{"position_pct":number,"leads_to":"string"}]}'

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
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
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 160)}`)
  }

  const data = await res.json() as any
  const text: string = data.content?.[0]?.text ?? '{}'
  try {
    const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
    const parsed = JSON.parse(clean)
    return {
      room_type: typeof parsed.room_type === 'string' ? parsed.room_type.toLowerCase() : 'room',
      doorways: Array.isArray(parsed.doorways)
        ? parsed.doorways.filter((d: any) =>
            typeof d.position_pct === 'number' &&
            d.position_pct >= 0 && d.position_pct <= 100,
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

// Opposite yaw in [-180, 180] range
function oppositeYaw(yaw: number): number {
  return yaw > 0 ? yaw - 180 : yaw + 180
}

export default async function (fastify: FastifyInstance) {
  fastify.post('/spaces/:spaceId/auto-link', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return reply.code(503).send({ statusMessage: 'AI auto-link requires ANTHROPIC_API_KEY to be configured on this server.' })
    }

    // Verify space ownership
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    // Fetch ready scenes — prefer capture timestamp order, fall back to manual order
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

    // Analyse each scene sequentially to avoid Anthropic rate limits
    const analyses: Array<{ sceneId: string } & SceneAnalysis> = []
    for (const scene of scenes) {
      if (!scene.thumbnail_url) {
        analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [] })
      } else {
        try {
          const result = await analyzeScene(scene.thumbnail_url, apiKey)
          analyses.push({ sceneId: scene.id, ...result })
          fastify.log.info({ sceneId: scene.id, room_type: result.room_type, doorways: result.doorways.length }, '[autolink] scene analysed')
        } catch (err: any) {
          fastify.log.warn({ err: err.message, sceneId: scene.id }, '[autolink] scene analysis failed — using fallback')
          analyses.push({ sceneId: scene.id, room_type: 'room', doorways: [] })
        }
      }
      await new Promise(r => setTimeout(r, 150))
    }

    const byId = Object.fromEntries(analyses.map(a => [a.sceneId, a]))

    // Build forward + back hotspot suggestions between every consecutive scene pair
    const suggestions: Array<{
      fromSceneId: string; fromSceneName: string
      toSceneId: string; toSceneName: string
      yaw: number; pitch: number
      label: string; doorwayDescription: string
    }> = []

    for (let i = 0; i < scenes.length - 1; i++) {
      const a = scenes[i]
      const b = scenes[i + 1]
      const analysisA = byId[a.id]
      const analysisB = byId[b.id]
      const labelB = titleCase(analysisB?.room_type || b.name)
      const labelA = titleCase(analysisA?.room_type || a.name)

      // Forward: A → B — use first detected doorway in A, or default to 0°
      const doorAB = analysisA?.doorways?.[0]
      const yawAB = doorAB ? Math.round((doorAB.position_pct / 100 - 0.5) * 360) : 0
      suggestions.push({
        fromSceneId: a.id, fromSceneName: a.name,
        toSceneId: b.id,   toSceneName: b.name,
        yaw: yawAB, pitch: DEFAULT_PITCH,
        label: labelB,
        doorwayDescription: doorAB?.leads_to || `Leads to ${labelB}`,
      })

      // Back: B → A — use first detected doorway in B, or flip the forward yaw
      const doorBA = analysisB?.doorways?.[0]
      const yawBA = doorBA ? Math.round((doorBA.position_pct / 100 - 0.5) * 360) : oppositeYaw(yawAB)
      suggestions.push({
        fromSceneId: b.id, fromSceneName: b.name,
        toSceneId: a.id,   toSceneName: a.name,
        yaw: yawBA, pitch: DEFAULT_PITCH,
        label: labelA,
        doorwayDescription: doorBA?.leads_to || `Back to ${labelA}`,
      })
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
