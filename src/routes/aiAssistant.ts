import { randomUUID } from 'node:crypto'
import { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { generateGemini, parseGeminiJson, type GeminiPart } from '../utils/gemini.js'
import { industryBrief } from '../utils/industry.js'
import { consumeAi, getAiUsage, AiLimitError } from '../utils/aiUsage.js'
import { previewEdit, renderRegionPreview } from '../utils/aiImageEdit.js'
import { decodeEquirect, renderPanoViews, rgbToJpeg, yawPitchToViewPoint, VIEW_YAWS_DEG } from '../utils/panoViews.js'
import { clean, toProposals, MAX_ACTIONS, type Ctx } from '../utils/aiProposals.js'

// AI assistant: the owner types what they want — for the whole tour, the scene
// they're looking at, or an area they drew on the photo — and gets back a list
// of proposed edits to review (hotspots, scene settings, listing text, photo
// edits). Nothing is written here: the editor applies the ticked proposals
// through the normal endpoints, exactly like auto-link.
//
// Billing: every assistant prompt counts against plans.ai_prompts_per_month;
// photo edits (paid image model) against ai_image_edits_per_month and only run
// when the owner presses "Preview edit" on a proposal.

const MAX_SCENES   = 20
const TOUR_IMAGE_W = 768

const sphericalPoint = z.object({ yaw: z.number().min(-Math.PI - 0.01).max(Math.PI + 0.01), pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2) })
const regionSchema   = z.object({ corners: z.array(sphericalPoint).length(4) })

const assistantBodySchema = z.object({
  prompt:  z.string().trim().min(2).max(1000),
  scope:   z.enum(['tour', 'scene', 'region']),
  sceneId: z.string().uuid().optional(),
  region:  regionSchema.optional(),
}).refine(b => b.scope === 'tour' || !!b.sceneId, { message: 'sceneId is required for scene and area prompts' })
  .refine(b => b.scope !== 'region' || !!b.region, { message: 'region is required for area prompts' })

const imageEditBodySchema = z.object({
  instruction: z.string().trim().min(3).max(500),
  corners:     z.array(sphericalPoint).length(4),
})

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })
const sceneParamsSchema = z.object({ sceneId: z.string().uuid() })
const editParamsSchema  = z.object({ sceneId: z.string().uuid(), editId: z.string().uuid() })


// ── Prompt ───────────────────────────────────────────────────────────────────
const SYSTEM = `You are the AI editor inside Viewora, a 360° virtual tour builder used by many industries
(homes, hotels, restaurants, schools, offices, shops, car dealerships, land, gyms, churches, clinics…).
The owner tells you what they want; you turn it into precise edits they can review and apply.

WHAT YOU CAN PROPOSE (actions):
• create_hotspot — kind "info" (label + description), "scene_link" (navigation arrow to another scene; needs target),
  "url" / "youtube" / "video" (ONLY with a URL the owner literally typed in their message — never invent links).
• update_hotspot — change label, description, position, size, category/icon, label colour of an existing hotspot.
• delete_hotspot — remove an existing hotspot.
• update_scene — rename a scene, set its category (group), set the direction it opens facing (start_view).
• update_listing — rewrite the public listing description (max 2000 chars) and/or title (max 120 chars).
• edit_image — change the PHOTO itself: remove an object, person, clutter, a car, the tripod; add an object
  (furniture, plant, books, décor). Only in scene or area mode, and only if photo_edits_available is true.

POSITIONS ("at"):
• Scene/area mode: {"view":<1-${VIEW_YAWS_DEG.length}>,"box_2d":[ymin,xmin,ymax,xmax]} — box 0-1000 in that view; the hotspot goes at the box centre.
  For edit_image the box is the area to change — make it hug the object with a little margin.
• Area mode: "area" = the centre of the owner's red-outlined area; {"area_box":[ymin,xmin,ymax,xmax]} = a box inside the AREA image.
• Tour mode: {"point":[y,x]} on that scene's panorama image, 0-1000 (x: full 360°, left and right edges meet; y: top to bottom).

RULES:
1. Do what the owner asked — nothing more. A vague request ("make this better") gets a focused, sensible set.
2. Be precise: positions must sit exactly on the object/doorway. If you can't find what they mean, say so in reply and propose nothing for it.
3. Honesty: never hide or invent permanent features or condition — no removing cracks, damp, stains, damage,
   power lines, neighbouring buildings or bad views; no adding windows, rooms or views that aren't there; no fake facts
   in text. Removing temporary things (people, clutter, cars, bins, the tripod) and adding staging décor is fine —
   when you add objects, remind the owner in reply to mention the photo is virtually staged.
   If asked for a dishonest edit, decline politely in reply and explain why.
4. Labels: 2-4 words, Title Case. Descriptions: 1-2 natural sentences, max 25 words, written for this tour's viewers
   (see <industry>), no hype words (stunning, luxurious, boasts, nestled).
5. Every action has a short "why" (max 15 words) the owner will read.
6. edit_image "instruction": a precise visual instruction for an image model, e.g. "Remove the blue plastic bin and
   fill in the tiled floor and wall behind it naturally." or "Place a neat stack of three hardcover books on the table".
7. Max ${MAX_ACTIONS} actions. Refer to scenes and hotspots ONLY by their ids (S1, H3…).

OUTPUT — only valid compact JSON:
{"reply":"<friendly 1-3 sentence answer to the owner>","actions":[
 {"type":"create_hotspot","scene":"S1","kind":"info","at":<at>,"label":"","description":"","category":"feature|view|highlight","size":"small|medium|large","target":"S2","url":"","label_color":"#RRGGBB","why":""},
 {"type":"update_hotspot","hotspot":"H3","label":"","description":"","at":<at>,"category":"","size":"","label_color":"","why":""},
 {"type":"delete_hotspot","hotspot":"H2","why":""},
 {"type":"update_scene","scene":"S1","name":"","group":"","start_view":<at>,"why":""},
 {"type":"update_listing","description":"","title":"","why":""},
 {"type":"edit_image","scene":"S1","at":<at>,"instruction":"","why":""}]}
Omit optional fields you don't change.`

async function fetchJpegB64(url: string, width: number): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(width, width / 2, { fit: 'fill' }).jpeg({ quality: 80 }).toBuffer()
    return buf.toString('base64')
  } catch {
    return null
  }
}

function sendAiError(reply: any, err: any) {
  if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message, code: 'ai_limit', kind: err.kind })
  if (err?.statusCode === 409) return reply.code(409).send({ statusMessage: err.message })
  if (/too (large|small)/i.test(err?.message ?? '')) return reply.code(400).send({ statusMessage: err.message })
  return null
}

// ── Routes ───────────────────────────────────────────────────────────────────
export default async function aiAssistantRoutes(fastify: FastifyInstance) {
  async function ownedScene(sceneId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('scenes')
      .select('id, space_id, name, raw_image_url, original_raw_image_url, status, properties!inner(user_id, property_type)')
      .eq('id', sceneId)
      .eq('properties.user_id', userId)
      .single()
    return data as any
  }

  // Monthly allowance + what's used, for the editor's usage meter
  fastify.get('/ai/usage', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    return reply.send(await getAiUsage(fastify, (req.user as any).sub))
  })

  fastify.post('/spaces/:spaceId/ai/assistant', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, assistantBodySchema, req.body)
    if (!body) return

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI assistant requires GEMINI_API_KEY to be configured on the server.' })

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id, title, property_type, location_text, description')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    const { data: scenes } = await fastify.supabase
      .from('scenes')
      .select('id, name, group_name, thumbnail_url, initial_yaw, initial_pitch')
      .eq('space_id', params.spaceId)
      .eq('status', 'ready')
      .order('order_index', { ascending: true })
      .limit(MAX_SCENES)
    if (!scenes?.length) return reply.code(400).send({ statusMessage: 'Add at least one ready 360° scene first.' })

    const focus = body.sceneId ? scenes.find(s => s.id === body.sceneId) : null
    if (body.scope !== 'tour' && !focus?.thumbnail_url) return reply.code(400).send({ statusMessage: 'That scene is not ready yet.' })

    const { data: hotspots } = await fastify.supabase
      .from('hotspots')
      .select('id, scene_id, type, label, yaw, pitch, target_scene_id, content')
      .in('scene_id', scenes.map(s => s.id))

    let refund: () => Promise<void>
    let usage: Awaited<ReturnType<typeof getAiUsage>>
    try {
      usage  = await getAiUsage(fastify, userId)
      refund = await consumeAi(fastify, userId, 'prompts')
    } catch (err: any) {
      return sendAiError(reply, err) ?? reply.code(500).send({ statusMessage: 'Could not check your AI allowance.' })
    }
    const canEditImages = usage.imageEdits.limit === null || usage.imageEdits.limit > usage.imageEdits.used

    try {
      // ── References the model uses instead of UUIDs ────────────────────────
      const sceneRef   = new Map<string, any>()
      const hotspotRef = new Map<string, any>()
      const sceneKey   = new Map<string, string>()
      scenes.forEach((s, i) => { sceneRef.set(`S${i + 1}`, s); sceneKey.set(s.id, `S${i + 1}`) })
      ;(hotspots ?? []).forEach((h, i) => hotspotRef.set(`H${i + 1}`, h))
      const hKey = new Map([...hotspotRef.entries()].map(([k, h]) => [h.id, k]))

      const ctx: Ctx = { scope: body.scope, focusId: focus?.id ?? null, sceneRef, hotspotRef, prompt: body.prompt }

      // ── Inventory ─────────────────────────────────────────────────────────
      const where = (h: any, sceneId: string) => {
        const yaw = Number(h.yaw || 0), pitch = Number(h.pitch || 0)
        if (body.scope !== 'tour' && sceneId === focus?.id) {
          const p = yawPitchToViewPoint(yaw, pitch)
          return p ? `view ${p.view + 1} x:${p.x} y:${p.y}` : 'outside views'
        }
        return `point [${Math.round((0.5 - pitch / Math.PI) * 1000)},${Math.round((yaw / (2 * Math.PI) + 0.5) * 1000)}]`
      }
      const inv: string[] = ['<tour_inventory>']
      inv.push(`Listing title: "${space.title || ''}"${space.location_text ? ` | location: ${space.location_text}` : ''}`)
      inv.push(`Listing description: ${space.description ? `"${space.description.slice(0, 1200)}"` : '(none yet)'}`)
      for (const s of scenes) {
        inv.push(`${sceneKey.get(s.id)} "${s.name || 'Untitled'}"${s.group_name ? ` [category: ${s.group_name}]` : ''}${s.id === focus?.id ? '  ← CURRENT SCENE' : ''}`)
        for (const h of (hotspots ?? []).filter(x => x.scene_id === s.id)) {
          const target = h.target_scene_id ? ` → ${sceneKey.get(h.target_scene_id) ?? '?'}` : ''
          const text = h.content?.text ? ` "${String(h.content.text).slice(0, 80)}"` : ''
          inv.push(`   ${hKey.get(h.id)} ${h.type}${target} "${h.label || ''}"${text} at ${where(h, s.id)}`)
        }
      }
      inv.push('</tour_inventory>')

      const modeLine = body.scope === 'tour'
        ? 'MODE: tour — the owner\'s request is about the whole tour. Each scene\'s panorama is attached. Use {"point":[y,x]} positions. Photo edits are not possible in this mode (tell the owner to open the scene).'
        : body.scope === 'scene'
          ? `MODE: scene — the request is about ${sceneKey.get(focus!.id)} "${focus!.name}". Its 6 views are attached. Use view/box positions for this scene.`
          : `MODE: area — the owner drew a red box on ${sceneKey.get(focus!.id)} "${focus!.name}". The AREA image shows it with surroundings; the 6 views show the whole scene. "this", "here", "it" mean the outlined area.`

      const parts: GeminiPart[] = [
        { text: industryBrief(space.property_type, space.title) },
        { text: inv.join('\n') },
        { text: `${modeLine}\nphoto_edits_available: ${canEditImages}${canEditImages ? '' : ` (plan "${usage.planName}" has no photo edits left — explain that photo editing needs a plan upgrade or next month)`}` },
      ]

      if (body.scope === 'tour') {
        const imgs = await Promise.all(scenes.map(s => s.thumbnail_url ? fetchJpegB64(s.thumbnail_url, TOUR_IMAGE_W) : Promise.resolve(null)))
        scenes.forEach((s, i) => {
          if (!imgs[i]) return
          parts.push({ text: `${sceneKey.get(s.id)} panorama:` })
          parts.push({ inline_data: { mime_type: 'image/jpeg', data: imgs[i]! } })
        })
      } else {
        const views = await renderPanoViews(focus!.thumbnail_url)
        for (const v of views) {
          parts.push({ text: `View ${v.index + 1}:` })
          parts.push({ inline_data: { mime_type: 'image/jpeg', data: v.jpegB64 } })
        }
        if (body.scope === 'region') {
          const res = await fetch(focus!.thumbnail_url)
          const src = await decodeEquirect(Buffer.from(await res.arrayBuffer()))
          const area = renderRegionPreview(src, body.region!.corners)
          ctx.areaView = { view: area.view, mask: area.mask }
          ctx.region   = body.region!.corners
          parts.push({ text: 'AREA (owner\'s selection outlined in red):' })
          parts.push({ inline_data: { mime_type: 'image/jpeg', data: (await rgbToJpeg(area.rgb, area.view.size)).toString('base64') } })
        }
      }

      parts.push({ text: `OWNER'S REQUEST:\n${body.prompt}` })

      const text   = await generateGemini({ apiKey, systemText: SYSTEM, parts, json: true })
      const parsed = parseGeminiJson(text)
      const proposals = toProposals(Array.isArray(parsed.actions) ? parsed.actions : [], ctx, canEditImages)

      return reply.send({
        reply:     clean(parsed.reply, 600) || (proposals.length ? 'Here’s what I suggest.' : 'I couldn’t find anything to change for that request.'),
        proposals,
        usage:     await getAiUsage(fastify, userId),
      })
    } catch (err: any) {
      await refund().catch(() => {})
      fastify.log.warn({ err: err.message, spaceId: params.spaceId }, '[ai-assistant] failed')
      return sendAiError(reply, err) ?? reply.code(502).send({ statusMessage: 'The AI assistant couldn’t answer right now — try again shortly. This request wasn’t counted.' })
    }
  })

  // ── Photo edit: preview (billed) ──────────────────────────────────────────
  fastify.post('/scenes/:sceneId/ai/image-edit', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, imageEditBodySchema, req.body)
    if (!body) return

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'Photo editing requires GEMINI_API_KEY to be configured on the server.' })

    const scene = await ownedScene(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })
    if (!scene.raw_image_url || scene.status !== 'ready') return reply.code(400).send({ statusMessage: 'This photo is still processing — try again in a minute.' })

    let refund: () => Promise<void>
    try {
      refund = await consumeAi(fastify, userId, 'image_edits')
    } catch (err: any) {
      return sendAiError(reply, err) ?? reply.code(500).send({ statusMessage: 'Could not check your AI allowance.' })
    }

    try {
      const result = await previewEdit({
        s3: fastify.s3, apiKey,
        spaceId: scene.space_id, sceneId: scene.id, spaceType: scene.properties?.property_type ?? null,
        rawImageUrl: scene.raw_image_url, corners: body.corners, instruction: body.instruction,
      })
      return reply.send({ ...result, usage: await getAiUsage(fastify, userId) })
    } catch (err: any) {
      await refund().catch(() => {})
      fastify.log.warn({ err: err.message, sceneId: scene.id }, '[ai-image-edit] preview failed')
      if (/declined/i.test(err.message)) return reply.code(422).send({ statusMessage: 'The image model couldn’t make that edit — try describing it differently. This edit wasn’t counted.' })
      return sendAiError(reply, err) ?? reply.code(502).send({ statusMessage: 'Photo edit failed — try again shortly. This edit wasn’t counted.' })
    }
  })

  // ── Photo edit: apply (free — the preview was already billed) ─────────────
  fastify.post('/scenes/:sceneId/ai/image-edit/:editId/apply', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, editParamsSchema, (req as any).params)
    if (!params) return
    const scene = await ownedScene(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })
    if (!fastify.uploadQueue) return reply.code(503).send({ statusMessage: 'Background processing is unavailable right now.' })

    await fastify.uploadQueue.add('ai-apply-edit', { sceneId: scene.id, spaceId: scene.space_id, editId: params.editId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    })
    // The editor polls the scene until tile_manifest_url contains this variant
    return reply.code(202).send({ variant: params.editId })
  })

  // ── Photo edit: back to the original photo ────────────────────────────────
  fastify.post('/scenes/:sceneId/ai/revert-image', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const scene = await ownedScene(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })
    if (!scene.original_raw_image_url) return reply.code(400).send({ statusMessage: 'This photo has no AI edits to undo.' })
    if (!fastify.uploadQueue) return reply.code(503).send({ statusMessage: 'Background processing is unavailable right now.' })

    const variant = `original-${randomUUID()}`
    await fastify.supabase.from('scenes')
      .update({ raw_image_url: scene.original_raw_image_url, original_raw_image_url: null })
      .eq('id', scene.id)
    await fastify.uploadQueue.add('tile-scene', {
      sceneId: scene.id, rawImageUrl: scene.original_raw_image_url, spaceId: scene.space_id, userId, variant,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
    return reply.code(202).send({ variant })
  })
}
