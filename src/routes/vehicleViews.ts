import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { invalidateSpaceCache } from '../utils/cache.js'

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
    return reply.send({ vehicle_views: data ?? [] })
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
  return data ?? []
}
