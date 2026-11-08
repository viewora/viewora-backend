import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { invalidateSpaceCache } from '../utils/cache.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { suggestAngles, suggestHotspots } from '../utils/vehicleAi.js'

// Single-vehicle exterior: a set of normal photos taken around the car.
// The viewer steps between them as the visitor drags (see
// migration-vehicle-views.sql). Interior is a normal 360 scene.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const viewParams = z.object({ viewId: z.string().uuid() })

const safeUrl = z.string().url().refine(u => /^https?:\/\//i.test(u), { message: 'URL must use http or https' })

export const MAX_VEHICLE_VIEWS = 36

export const CreateVehicleViewBody = z.object({
  image_url: safeUrl,
  media_id: z.string().uuid().optional().nullable(),
  label: z.string().trim().min(1).max(40).optional().nullable(),
  angle: z.number().int().min(0).max(359),
  width: z.number().int().min(1).max(20000).optional().nullable(),
  height: z.number().int().min(1).max(20000).optional().nullable(),
})

export const UpdateVehicleViewBody = z.object({
  label: z.string().trim().min(1).max(40).optional().nullable(),
  angle: z.number().int().min(0).max(359).optional(),
})

export const MAX_HOTSPOTS_PER_VIEW = 20

const hotspotFields = {
  kind: z.enum(['feature', 'damage', 'info', 'link']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().max(400).optional().nullable(),
  url: safeUrl.max(500).optional().nullable(),
}
export const CreateVehicleHotspotBody = z.object(hotspotFields)
export const UpdateVehicleHotspotBody = z.object(hotspotFields).partial()

// Several photos' angles at once (swap two photos, or accept an AI sort) in one write.
const AnglesBody = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    angle: z.number().int().min(0).max(359),
    label: z.string().trim().min(1).max(40).optional().nullable(),
  })).min(1).max(MAX_VEHICLE_VIEWS),
})

const hotspotParams = z.object({ hotspotId: z.string().uuid() })

const HOTSPOT_COLUMNS = 'id, view_id, kind, x, y, title, body, url'

const ReorderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(MAX_VEHICLE_VIEWS) })

const COLUMNS = 'id, space_id, media_id, image_url, label, angle, width, height, order_index, created_at'

export default async function vehicleViewRoutes(fastify: FastifyInstance) {
  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }
  async function ownedView(viewId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_views')
      .select('id, space_id, media_id, properties!inner(user_id)')
      .eq('id', viewId).eq('properties.user_id', userId).maybeSingle()
    return data
  }

  fastify.get('/spaces/:spaceId/vehicle-views', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { data, error } = await fastify.supabase
      .from('vehicle_views').select(COLUMNS).eq('space_id', params.spaceId)
      .order('order_index', { ascending: true }).order('created_at', { ascending: true })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to load car photos' })
    }
    return reply.send({ vehicle_views: await withHotspots(fastify, data ?? []) })
  })

  // The image is uploaded first via /uploads/create-signed-url (mediaType 'vehicle_view').
  fastify.post('/spaces/:spaceId/vehicle-views', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateVehicleViewBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { count } = await fastify.supabase
      .from('vehicle_views').select('id', { count: 'exact', head: true }).eq('space_id', params.spaceId)
    if ((count ?? 0) >= MAX_VEHICLE_VIEWS) {
      return reply.code(400).send({ statusMessage: `Up to ${MAX_VEHICLE_VIEWS} exterior photos per car.` })
    }

    const { data, error } = await fastify.supabase
      .from('vehicle_views')
      .insert({
        space_id: params.spaceId,
        image_url: body.image_url,
        media_id: body.media_id ?? null,
        label: body.label ?? null,
        angle: body.angle,
        width: body.width ?? null,
        height: body.height ?? null,
        order_index: count ?? 0,
      })
      .select(COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to add car photo' })
    }
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(201).send({ vehicle_view: data })
  })

  fastify.patch('/vehicle-views/:viewId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateVehicleViewBody, req.body)
    if (!body) return
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { data, error } = await fastify.supabase
      .from('vehicle_views')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.viewId).select(COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save car photo' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ vehicle_view: data })
  })

  // Rewrites order_index to match the array position.
  fastify.put('/spaces/:spaceId/vehicle-views/order', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, ReorderBody, req.body)
    if (!body) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const results = await Promise.all(body.orderedIds.map((id, i) =>
      fastify.supabase.from('vehicle_views').update({ order_index: i }).eq('id', id).eq('space_id', params.spaceId)))
    if (results.some(r => r.error)) return reply.code(500).send({ statusMessage: 'Failed to save the order' })
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(204).send()
  })

  // Several angles at once. Used by drag-to-swap in the editor and by "accept AI sort".
  fastify.put('/spaces/:spaceId/vehicle-views/angles', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, AnglesBody, req.body)
    if (!body) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const now = new Date().toISOString()
    const results = await Promise.all(body.items.map(it =>
      fastify.supabase.from('vehicle_views')
        .update({ angle: it.angle, ...(it.label !== undefined ? { label: it.label } : {}), updated_at: now })
        .eq('id', it.id).eq('space_id', params.spaceId)))
    if (results.some(r => r.error)) return reply.code(500).send({ statusMessage: 'Failed to save the new order' })
    await invalidateSpaceCache(fastify, params.spaceId)
    const { data } = await fastify.supabase
      .from('vehicle_views').select(COLUMNS).eq('space_id', params.spaceId)
      .order('order_index', { ascending: true }).order('created_at', { ascending: true })
    return reply.send({ vehicle_views: await withHotspots(fastify, data ?? []) })
  })

  // ── HOTSPOTS ──────────────────────────────────────────────
  fastify.post('/vehicle-views/:viewId/hotspots', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateVehicleHotspotBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { count } = await fastify.supabase
      .from('vehicle_hotspots').select('id', { count: 'exact', head: true }).eq('view_id', params.viewId)
    if ((count ?? 0) >= MAX_HOTSPOTS_PER_VIEW) {
      return reply.code(400).send({ statusMessage: `Up to ${MAX_HOTSPOTS_PER_VIEW} hotspots per photo.` })
    }
    const { data, error } = await fastify.supabase
      .from('vehicle_hotspots')
      .insert({ view_id: params.viewId, space_id: owned.space_id, ...body, body: body.body ?? null, url: body.url ?? null })
      .select(HOTSPOT_COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to add hotspot' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(201).send({ hotspot: data })
  })

  async function ownedHotspot(hotspotId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_hotspots')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', hotspotId).eq('properties.user_id', userId).maybeSingle()
    return data
  }

  fastify.patch('/vehicle-hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateVehicleHotspotBody, req.body)
    if (!body) return
    const owned = await ownedHotspot(params.hotspotId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Hotspot not found' })
    const { data, error } = await fastify.supabase
      .from('vehicle_hotspots')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.hotspotId).select(HOTSPOT_COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save hotspot' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ hotspot: data })
  })

  fastify.delete('/vehicle-hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParams, (req as any).params)
    if (!params) return
    const owned = await ownedHotspot(params.hotspotId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Hotspot not found' })
    const { error } = await fastify.supabase.from('vehicle_hotspots').delete().eq('id', params.hotspotId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete hotspot' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })

  // ── AI (suggestions only: nothing is saved until the owner accepts) ──
  fastify.post('/spaces/:spaceId/vehicle-views/ai-sort', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI is not configured on the server.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { data: views } = await fastify.supabase
      .from('vehicle_views').select('id, image_url').eq('space_id', params.spaceId)
      .order('created_at', { ascending: true }).limit(MAX_VEHICLE_VIEWS)
    if (!views?.length) return reply.code(400).send({ statusMessage: 'Add some photos first.' })

    let refund: () => Promise<void>
    try { refund = await consumeAi(fastify, userId, 'prompts') } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }
    try {
      return reply.send({ suggestions: await suggestAngles(apiKey, views) })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, spaceId: params.spaceId }, '[vehicle ai-sort] failed')
      await refund().catch(() => {})
      return reply.code(502).send({ statusMessage: 'Could not sort the photos right now. Try again shortly.' })
    }
  })

  fastify.post('/vehicle-views/:viewId/ai-hotspots', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI is not configured on the server.' })
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })

    const [{ data: view }, { data: space }] = await Promise.all([
      fastify.supabase.from('vehicle_views').select('image_url').eq('id', params.viewId).single(),
      fastify.supabase.from('properties').select('title, vehicle_year').eq('id', owned.space_id).single(),
    ])
    if (!view?.image_url) return reply.code(404).send({ statusMessage: 'Car photo not found' })

    let refund: () => Promise<void>
    try { refund = await consumeAi(fastify, userId, 'prompts') } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }
    try {
      const context = [space?.vehicle_year, space?.title].filter(Boolean).join(' ')
      return reply.send({ suggestions: await suggestHotspots(apiKey, view.image_url, context || undefined) })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, viewId: params.viewId }, '[vehicle ai-hotspots] failed')
      await refund().catch(() => {})
      return reply.code(502).send({ statusMessage: 'Could not suggest hotspots right now. Try again shortly.' })
    }
  })

  // The image file itself is removed by the client via DELETE /uploads/:mediaId.
  fastify.delete('/vehicle-views/:viewId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { error } = await fastify.supabase.from('vehicle_views').delete().eq('id', params.viewId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete car photo' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })
}

/** Adds each photo's hotspots. Read separately so a database without the hotspots table still serves photos. */
async function withHotspots(fastify: FastifyInstance, views: any[]) {
  if (!views.length) return views
  const { data, error } = await fastify.supabase
    .from('vehicle_hotspots').select(HOTSPOT_COLUMNS).in('view_id', views.map(v => v.id))
    .order('created_at', { ascending: true })
  const byView = new Map<string, any[]>()
  if (!error) for (const h of data ?? []) byView.set(h.view_id, [...(byView.get(h.view_id) ?? []), h])
  return views.map(v => ({ ...v, hotspots: byView.get(v.id) ?? [] }))
}

/** Public, read-only: exterior photos for a published space (fetched fresh, not cached). */
export async function publicVehicleViews(fastify: FastifyInstance, spaceId: string) {
  const { data, error } = await fastify.supabase
    .from('vehicle_views')
    .select('id, image_url, label, angle, width, height, order_index')
    .eq('space_id', spaceId)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: true })
  // Missing table (migration not run yet) must not break the public tour.
  if (error) return []
  return withHotspots(fastify, data ?? [])
}
