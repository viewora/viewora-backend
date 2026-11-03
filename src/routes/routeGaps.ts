import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'

// Routes the venue map was asked for that the 360 tour can't walk. Logged by
// the viewer, reviewed by the space owner to decide where to add hotspots.

const gapBodySchema = z.object({
  spaceId: z.string().uuid(),
  reason: z.enum(['destination', 'start', 'detour', 'partial']),
  fromRef: z.string().trim().min(1).max(200),
  fromName: z.string().max(200).optional(),
  fromFloorId: z.string().max(100).optional(),
  toRef: z.string().trim().min(1).max(200),
  toName: z.string().max(200).optional(),
  toFloorId: z.string().max(100).optional(),
  startSceneId: z.string().max(100).nullable().optional(),
  directLength: z.number().finite().nullable().optional(),
})

const idParamsSchema = z.object({ id: z.string().uuid() })

const patchBodySchema = z.object({
  status: z.enum(['open', 'resolved', 'ignored']).optional(),
  note: z.string().max(1000).nullable().optional(),
}).refine(b => b.status !== undefined || b.note !== undefined, { message: 'status or note is required' })

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: a visitor hit a route the tour doesn't cover
  fastify.post('/', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (request: any) => request.ip },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, gapBodySchema, request.body)
    if (!body) return

    // Only published tours collect gaps (the viewer is public, the table isn't).
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id, is_published')
      .eq('id', body.spaceId)
      .single()
    if (!space || !space.is_published) return reply.code(404).send({ statusMessage: 'Tour not found' })

    const { error } = await fastify.supabase.rpc('log_route_gap', {
      p_property_id: body.spaceId,
      p_from_ref: body.fromRef,
      p_from_name: sanitizeLeadText(body.fromName ?? '', 200),
      p_from_floor_id: body.fromFloorId ?? null,
      p_to_ref: body.toRef,
      p_to_name: sanitizeLeadText(body.toName ?? '', 200),
      p_to_floor_id: body.toFloorId ?? null,
      p_reason: body.reason,
      p_start_scene_id: body.startSceneId ?? null,
      p_direct_length: body.directLength ?? null,
    })
    if (error) {
      // Never break the visitor's directions over a log write.
      fastify.log.warn({ error }, 'Failed to log route gap')
    }
    return reply.code(202).send({ ok: true })
  })

  // AUTH ROUTE: gaps across the user's spaces, most requested first
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).sub
    const query = request.query as { status?: string; spaceId?: string }
    const limit = 500

    const { data: userProps, error: propsErr } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('user_id', userId)
    if (propsErr) {
      fastify.log.error(propsErr)
      return reply.code(500).send({ statusMessage: 'Failed to fetch route gaps' })
    }
    let propIds = (userProps ?? []).map((p: any) => p.id)
    if (query.spaceId) propIds = propIds.filter((id: string) => id === query.spaceId)
    if (!propIds.length) return reply.send({ data: [], total: 0 })

    let q = fastify.supabase
      .from('route_coverage_gaps')
      .select('*, properties(id, title, slug)', { count: 'exact' })
      .in('property_id', propIds)
      .order('hits', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(limit)
    if (query.status && ['open', 'resolved', 'ignored'].includes(query.status)) q = q.eq('status', query.status)

    const { data, error, count } = await q
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch route gaps' })
    }
    return reply.send({ data: data ?? [], total: count ?? 0 })
  })

  // AUTH ROUTE: mark a gap resolved / ignored / open, or leave a note
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, patchBodySchema, request.body)
    if (!body) return

    const { data: gap } = await fastify.supabase
      .from('route_coverage_gaps')
      .select('id, property_id')
      .eq('id', params.id)
      .single()
    if (!gap) return reply.code(404).send({ statusMessage: 'Not found' })

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', gap.property_id)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(403).send({ statusMessage: 'Unauthorized' })

    const patch: Record<string, unknown> = {}
    if (body.status !== undefined) patch.status = body.status
    if (body.note !== undefined) patch.note = body.note === null ? null : sanitizeLeadText(body.note, 1000)

    const { data: updated, error } = await fastify.supabase
      .from('route_coverage_gaps')
      .update(patch)
      .eq('id', params.id)
      .select('id, status, note')
      .single()
    if (error) return reply.code(500).send({ statusMessage: 'Failed to update' })
    return reply.send(updated)
  })
}
