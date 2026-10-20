import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { invalidateSpaceCache } from '../utils/cache.js'

// Floor plans: one uploaded plan image per floor (see
// migration-add-floor-plans.sql). Scenes are pinned on a floor through
// scenes.floor_plan_id / plan_x / plan_y, saved via PATCH /scenes/:sceneId.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const floorPlanParams = z.object({ floorPlanId: z.string().uuid() })

const safeUrl = z.string().url().refine(u => /^https?:\/\//i.test(u), { message: 'URL must use http or https' })

export const MAX_FLOOR_PLANS_PER_SPACE = 10

export const CreateFloorPlanBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  image_url: safeUrl,
  media_id: z.string().uuid().optional().nullable(),
  width: z.number().int().min(1).max(20000).optional().nullable(),
  height: z.number().int().min(1).max(20000).optional().nullable(),
})

export const UpdateFloorPlanBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  order_index: z.number().int().min(0).max(1000).optional(),
})

const COLUMNS = 'id, space_id, name, image_url, media_id, width, height, order_index, created_at, updated_at'

export default async function floorPlanRoutes(fastify: FastifyInstance) {
  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }

  async function ownedFloorPlan(floorPlanId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('floor_plans')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', floorPlanId)
      .eq('properties.user_id', userId)
      .maybeSingle()
    return data
  }

  // ── LIST (owner) ──────────────────────────────────────────
  fastify.get('/spaces/:spaceId/floor-plans', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { data, error } = await fastify.supabase
      .from('floor_plans').select(COLUMNS).eq('space_id', params.spaceId)
      .order('order_index', { ascending: true }).order('created_at', { ascending: true })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to load floor plans' })
    }
    return reply.send({ floor_plans: data ?? [] })
  })

  // ── CREATE ────────────────────────────────────────────────
  // The image itself is uploaded first via /uploads/create-signed-url
  // (mediaType 'floor_plan'); this registers it as a floor.
  fastify.post('/spaces/:spaceId/floor-plans', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateFloorPlanBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { count } = await fastify.supabase
      .from('floor_plans').select('id', { count: 'exact', head: true }).eq('space_id', params.spaceId)
    if ((count ?? 0) >= MAX_FLOOR_PLANS_PER_SPACE) {
      return reply.code(400).send({ statusMessage: `Up to ${MAX_FLOOR_PLANS_PER_SPACE} floor plans per listing.` })
    }

    const { data, error } = await fastify.supabase
      .from('floor_plans')
      .insert({
        space_id: params.spaceId,
        name: body.name ?? ((count ?? 0) === 0 ? 'Ground Floor' : `Floor ${(count ?? 0) + 1}`),
        image_url: body.image_url,
        media_id: body.media_id ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        order_index: count ?? 0,
      })
      .select(COLUMNS)
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to add floor plan' })
    }
    return reply.code(201).send({ floor_plan: data })
  })

  // ── UPDATE (name / order) ─────────────────────────────────
  fastify.patch('/floor-plans/:floorPlanId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, floorPlanParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateFloorPlanBody, req.body)
    if (!body) return
    const owned = await ownedFloorPlan(params.floorPlanId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Floor plan not found' })

    const { data, error } = await fastify.supabase
      .from('floor_plans')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.floorPlanId)
      .select(COLUMNS)
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save floor plan' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ floor_plan: data })
  })

  // ── DELETE ────────────────────────────────────────────────
  // Scenes pinned on this floor become unplaced. The image itself is removed
  // by the client via DELETE /uploads/:mediaId, which also frees the quota.
  fastify.delete('/floor-plans/:floorPlanId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, floorPlanParams, (req as any).params)
    if (!params) return
    const owned = await ownedFloorPlan(params.floorPlanId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Floor plan not found' })

    const { error: unpinError } = await fastify.supabase
      .from('scenes')
      .update({ floor_plan_id: null, plan_x: null, plan_y: null })
      .eq('floor_plan_id', params.floorPlanId)
    if (unpinError) {
      fastify.log.error(unpinError)
      return reply.code(500).send({ statusMessage: 'Failed to delete floor plan' })
    }
    const { error } = await fastify.supabase.from('floor_plans').delete().eq('id', params.floorPlanId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete floor plan' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })
}

/** Public, read-only: floor plans for a published space (fetched fresh, not cached). */
export async function publicFloorPlans(fastify: FastifyInstance, spaceId: string) {
  const { data, error } = await fastify.supabase
    .from('floor_plans')
    .select('id, name, image_url, width, height, order_index')
    .eq('space_id', spaceId)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: true })
  // Missing table (migration not run yet) must not break the public tour.
  if (error) return []
  return data ?? []
}

/**
 * Merges each scene's floor-plan pin into scene rows that came from
 * get_tour_data() (whose column list can't be changed from here).
 * Missing columns → no-op, so the tour loads exactly as before.
 */
export async function mergeScenePlanPins(fastify: FastifyInstance, spaceId: string, scenes: any[] | null | undefined) {
  if (!Array.isArray(scenes) || !scenes.length) return
  const { data, error } = await fastify.supabase
    .from('scenes').select('id, floor_plan_id, plan_x, plan_y, north_offset').eq('space_id', spaceId)
  if (error || !data) return
  const byId = new Map(data.map((r: any) => [r.id, r]))
  for (const s of scenes) {
    const pin: any = byId.get(s.id)
    if (!pin) continue
    s.floor_plan_id = pin.floor_plan_id ?? null
    s.plan_x = pin.plan_x ?? null
    s.plan_y = pin.plan_y ?? null
    s.north_offset = pin.north_offset ?? null
  }
}
