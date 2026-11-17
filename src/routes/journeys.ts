import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { invalidateSpaceCache } from '../utils/cache.js'

// Journeys: self-playing guided visits through a tour, step by step, timed by
// narration (see migration-journeys.sql). Made for hospitals first: "what
// happens to me from the gate to the exit". The app turns the stored steps
// into what the viewer plays (viewora-app shared/utils/journey.ts).

const spaceParams = z.object({ spaceId: z.string().uuid() })
const journeyParams = z.object({ journeyId: z.string().uuid() })

export const MAX_JOURNEYS_PER_SPACE = 10
export const MAX_STEPS = 40
export const MAX_SENTENCES = 20

const localId = z.string().trim().min(1).max(40).regex(/^[\w-]+$/)
const angle = z.number().finite().min(-20).max(20)

// Where to look: radians as PSV reports them; zoom = PSV level 0 (wide) – 100 (closest), absent = wide.
const View = z.object({ yaw: angle, pitch: angle, zoom: z.number().min(0).max(100).optional() })

export const JourneyStep = z.object({
  id: localId,
  title: z.string().trim().max(80),
  scene_id: z.string().uuid().nullable(),
  /** Arrival view, which is also line 1's. */
  view: View.nullable().optional(),
  sentences: z.array(z.object({
    id: localId,
    text: z.string().max(400),
    /** Where to look while this line is read (lines 2+); absent = keep looking. */
    view: View.nullable().optional(),
  })).max(MAX_SENTENCES),
})

export const CreateJourneyBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  steps: z.array(JourneyStep).max(MAX_STEPS).optional(),
})

export const UpdateJourneyBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  steps: z.array(JourneyStep).max(MAX_STEPS).optional(),
  is_published: z.boolean().optional(),
  order_index: z.number().int().min(0).max(1000).optional(),
})

const COLUMNS = 'id, space_id, title, steps, is_published, order_index, created_at, updated_at'
const QUOTA_MESSAGE = 'Your plan does not allow changes right now. Please renew to continue.'

/** The table is missing until migration-journeys.sql has run. */
function tableMissing(error: any) {
  const m = String(error?.message || '')
  return error?.code === '42P01' || error?.code === 'PGRST205' || (/journeys/i.test(m) && /(does not exist|schema cache)/i.test(m))
}
const NOT_ENABLED = 'Patient journeys are not enabled yet (database migration pending).'

export default async function journeyRoutes(fastify: FastifyInstance) {
  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }

  async function ownedJourney(journeyId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('journeys')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', journeyId)
      .eq('properties.user_id', userId)
      .maybeSingle()
    return data as { id: string; space_id: string } | null
  }

  // ── LIST (owner) ──────────────────────────────────────────
  fastify.get('/spaces/:spaceId/journeys', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { data, error } = await fastify.supabase
      .from('journeys').select(COLUMNS).eq('space_id', params.spaceId)
      .order('order_index', { ascending: true }).order('created_at', { ascending: true })
    if (error) {
      if (tableMissing(error)) return reply.send({ journeys: [], enabled: false })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to load journeys' })
    }
    return reply.send({ journeys: data ?? [], enabled: true })
  })

  // ── CREATE ────────────────────────────────────────────────
  fastify.post('/spaces/:spaceId/journeys', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateJourneyBody, req.body ?? {})
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: QUOTA_MESSAGE })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { count, error: countError } = await fastify.supabase
      .from('journeys').select('id', { count: 'exact', head: true }).eq('space_id', params.spaceId)
    if (countError && tableMissing(countError)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
    if ((count ?? 0) >= MAX_JOURNEYS_PER_SPACE) {
      return reply.code(400).send({ statusMessage: `A tour can have up to ${MAX_JOURNEYS_PER_SPACE} journeys.` })
    }

    const { data, error } = await fastify.supabase
      .from('journeys')
      .insert({
        space_id: params.spaceId,
        title: body.title ?? 'Patient visit',
        steps: body.steps ?? [],
        order_index: count ?? 0,
      })
      .select(COLUMNS)
      .single()
    if (error) {
      if (tableMissing(error)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to create the journey' })
    }
    return reply.code(201).send({ journey: data })
  })

  // ── UPDATE (title, steps, published, order) ───────────────
  // The editor saves the whole step list at once, so a journey is never half-saved.
  fastify.put('/journeys/:journeyId', { preHandler: [fastify.authenticate], bodyLimit: 1048576 }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, journeyParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateJourneyBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: QUOTA_MESSAGE })
    const owned = await ownedJourney(params.journeyId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Journey not found' })

    const { data, error } = await fastify.supabase
      .from('journeys')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.journeyId)
      .select(COLUMNS)
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save the journey' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ journey: data })
  })

  // ── DELETE ────────────────────────────────────────────────
  fastify.delete('/journeys/:journeyId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, journeyParams, (req as any).params)
    if (!params) return
    const owned = await ownedJourney(params.journeyId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Journey not found' })
    const { error } = await fastify.supabase.from('journeys').delete().eq('id', params.journeyId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete the journey' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })
}

/**
 * Public, read-only: a tour's published journeys (fetched fresh, not cached,
 * like floor plans). A database without the table yet gives none.
 */
export async function publicJourneys(fastify: FastifyInstance, spaceId: string) {
  const { data, error } = await fastify.supabase
    .from('journeys')
    .select('id, title, steps, order_index')
    .eq('space_id', spaceId)
    .eq('is_published', true)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data.map((j: any) => ({ id: j.id, title: j.title, steps: Array.isArray(j.steps) ? j.steps : [] }))
}
