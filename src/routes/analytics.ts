import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { VISIT_EVENTS, placeNames, summarizeVisits, type JourneyInfo, type VisitEventRow } from '../utils/visitInsights.js'

const sourceSchema = z.enum(['direct', 'qr', 'embed'])

const viewBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  source: sourceSchema.optional(),
}).superRefine((data, ctx) => {
  if (!data.spaceId && !data.propertyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spaceId or propertyId is required',
      path: ['spaceId'],
    })
  }
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const engagementBodySchema = z.object({
  propertyId: z.string().uuid(),
  action: z.enum(['phone_reveal', 'whatsapp_click', 'save']),
})

// What visitors do inside a tour with guided visits (migration-visit-events.sql).
// Sent in batches by the viewer; with navigator.sendBeacon the body arrives
// as text/plain (a JSON content type would need a CORS preflight, which
// beacons can't do), so a string body is parsed here.
const shortId = z.string().trim().min(8).max(64).regex(/^[\w-]+$/)
export const VisitEventsBody = z.object({
  spaceId: z.string().uuid(),
  visitorId: shortId,
  sessionId: shortId,
  events: z.array(z.object({
    event: z.enum(VISIT_EVENTS),
    journeyId: z.string().uuid().nullish(),
    sceneId: z.string().uuid().nullish(),
    step: z.number().int().min(0).max(1000).nullish(),
    value: z.number().int().min(0).max(86_400_000).nullish(),
    /** Only these two keys are kept. */
    meta: z.object({
      device: z.enum(['phone', 'tablet', 'desktop']).optional(),
      from: z.string().uuid().optional(),
    }).nullish(),
  })).min(1).max(50),
})

const visitsQuerySchema = z.object({
  days: z.coerce.number().int().refine(d => [7, 30, 90, 365].includes(d)).default(30),
  spaceId: z.string().uuid().optional(),
})

/** visit_events is missing until migration-visit-events.sql has run. */
function eventsTableMissing(error: any) {
  const m = String(error?.message || '')
  return error?.code === '42P01' || error?.code === 'PGRST205' || (/visit_events/i.test(m) && /(does not exist|schema cache)/i.test(m))
}

export default async function (fastify: FastifyInstance) {
  type ViewSource = 'direct' | 'qr' | 'embed'
  const VALID_SOURCES: ViewSource[] = ['direct', 'qr', 'embed']
  const SOURCE_COLUMN: Record<ViewSource, 'direct_views' | 'qr_views' | 'embed_views'> = {
    direct: 'direct_views',
    qr: 'qr_views',
    embed: 'embed_views',
  }

  // PUBLIC ROUTE: Increment views
  fastify.post('/view', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, viewBodySchema, request.body)
    if (!body) return

    const spaceId = body.spaceId || body.propertyId || null
    const rawSource = body.source || 'direct'
    const source: ViewSource = VALID_SOURCES.includes(rawSource as ViewSource)
      ? (rawSource as ViewSource)
      : 'direct'
    const today = new Date().toISOString().split('T')[0]

    // Increment via RPC
    const { error } = await fastify.supabase.rpc('increment_daily_views', {
      prop_id: spaceId,
      event_date: today,
      view_source: source,
    })

    if (error) {
      // Fallback: manual increment if RPC not yet deployed.
      // Optimistic-insert first to avoid a SELECT round-trip; on conflict (concurrent
      // request already created the row) fall back to update.
      const sourceCol = SOURCE_COLUMN[source]
      const { error: insertErr } = await fastify.supabase
        .from('analytics_daily')
        .insert({ property_id: spaceId, date: today, total_views: 1, [sourceCol]: 1 })

      if (insertErr) {
        // Row already exists — read latest counts then increment
        const { data: existing } = await fastify.supabase
          .from('analytics_daily')
          .select('id, total_views, direct_views, qr_views, embed_views')
          .eq('property_id', spaceId)
          .eq('date', today)
          .single()

        if (existing) {
          await fastify.supabase
            .from('analytics_daily')
            .update({
              total_views: (existing.total_views ?? 0) + 1,
              [sourceCol]: (existing[sourceCol] ?? 0) + 1,
            })
            .eq('id', existing.id)
        }
      }
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Get total summary for all spaces
  fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch daily stats for all user's spaces
    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id, title)')
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })
      .limit(90)

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    }

    // Map property_id to space_id for frontend consistency
    const mappedData = (data || []).map(d => ({
      ...d,
      space_id: d.property_id,
      spaces: d.properties
    }))

    return reply.send(mappedData)
  })

  // AUTH ROUTE: Get space stats
  fastify.get('/summary/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id)')
      .eq('property_id', id)
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })
      .limit(30)

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    return reply.send(data)
  })

  // PUBLIC ROUTE: Log a buyer-intent event (property_engagements — see
  // migration-add-listing-facts.sql). 'view' is deliberately not accepted
  // here — analytics_daily/POST /view above already covers raw views, and
  // double-writing the same signal to two tables on every page load isn't
  // worth the extra write. This is for the higher-intent, currently-unwired
  // actions: tapping WhatsApp, saving a listing.
  fastify.post('/engagement', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, engagementBodySchema, request.body)
    if (!body) return

    const { error } = await fastify.supabase
      .from('property_engagements')
      .insert({
        property_id: body.propertyId,
        action: body.action,
        ip_address: request.ip,
      })

    if (error) {
      fastify.log.error(error, 'Failed to log engagement')
      // Non-critical signal — don't fail the buyer's actual action over it.
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Raw engagement rows across all of the caller's spaces —
  // mirrors GET /summary's shape (raw per-row data, aggregated client-side)
  // rather than a pre-aggregated total, so the dashboard's existing
  // selectedInsightsTourId per-tour filter works on this the same way it
  // already works on view/lead stats, with no extra endpoint needed per tour.
  fastify.get('/engagement', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data, error } = await fastify.supabase
      .from('property_engagements')
      .select('property_id, action, properties!inner(user_id)')
      .eq('properties.user_id', userId)
      .in('action', ['whatsapp_click', 'save'])

    if (error) {
      fastify.log.error(error, 'Failed to fetch engagement stats')
      return reply.code(500).send({ statusMessage: 'Failed to fetch engagement stats' })
    }

    return reply.send((data || []).map((row: any) => ({ property_id: row.property_id, action: row.action })))
  })

  // AUTH ROUTE: Engagement counts for one space, owner-only.
  fastify.get('/engagement/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const [{ count: whatsappClicks }, { count: saves }] = await Promise.all([
      fastify.supabase.from('property_engagements').select('id', { count: 'exact', head: true }).eq('property_id', id).eq('action', 'whatsapp_click'),
      fastify.supabase.from('property_engagements').select('id', { count: 'exact', head: true }).eq('property_id', id).eq('action', 'save'),
    ])

    return reply.send({ whatsapp_click: whatsappClicks ?? 0, save: saves ?? 0 })
  })

  // PUBLIC ROUTE: a batch of visit events from the viewer. Never fails the
  // visitor: bad batches are dropped with 204 too (nothing to show them).
  fastify.post('/events', {
    config: {
      rateLimit: {
        // A hospital's waiting-room wifi is one IP for many visitors.
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    let raw: unknown = request.body
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { return reply.code(400).send({ statusMessage: 'Invalid JSON' }) }
    }
    const body = parseWithSchema(reply, VisitEventsBody, raw)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties').select('id').eq('id', body.spaceId).maybeSingle()
    if (!space) return reply.code(204).send()

    const rows = body.events.map(e => ({
      space_id: body.spaceId,
      visitor_id: body.visitorId,
      session_id: body.sessionId,
      event: e.event,
      journey_id: e.journeyId ?? null,
      scene_id: e.sceneId ?? null,
      step: e.step ?? null,
      value: e.value ?? null,
      meta: e.meta && (e.meta.device || e.meta.from) ? e.meta : null,
    }))
    const { error } = await fastify.supabase.from('visit_events').insert(rows)
    if (error && !eventsTableMissing(error)) fastify.log.error(error, 'Failed to store visit events')
    return reply.code(204).send()
  })

  // AUTH ROUTE: guided-visit insights across the caller's tours, or one tour.
  fastify.get('/visits', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const query = parseWithSchema(reply, visitsQuerySchema, request.query)
    if (!query) return

    let spacesQ = fastify.supabase.from('properties').select('id, title').eq('user_id', user.sub)
    if (query.spaceId) spacesQ = spacesQ.eq('id', query.spaceId)
    const { data: spaces, error: spacesErr } = await spacesQ
    if (spacesErr) return reply.code(500).send({ statusMessage: 'Failed to fetch insights' })
    const ids = (spaces || []).map((s: any) => s.id as string)
    if (query.spaceId && !ids.length) return reply.code(404).send({ statusMessage: 'Space not found' })

    const since = new Date(Date.now() - query.days * 86400000).toISOString()
    const empty = summarizeVisits([], [], new Map(), query.days)
    if (!ids.length) return reply.send({ enabled: true, ...empty })

    const [eventsRes, journeysRes, scenesRes] = await Promise.all([
      fastify.supabase
        .from('visit_events')
        .select('space_id, visitor_id, session_id, event, journey_id, scene_id, step, value, meta, created_at')
        .in('space_id', ids)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50000),
      fastify.supabase.from('journeys').select('id, title, steps, order_index').in('space_id', ids)
        .order('order_index', { ascending: true }).order('created_at', { ascending: true }),
      fastify.supabase.from('scenes').select('id, name').in('space_id', ids),
    ])
    if (eventsRes.error) {
      if (eventsTableMissing(eventsRes.error)) return reply.send({ enabled: false, ...empty })
      fastify.log.error(eventsRes.error, 'Failed to fetch visit events')
      return reply.code(500).send({ statusMessage: 'Failed to fetch insights' })
    }
    const journeys: JourneyInfo[] = (journeysRes.data || []).map((j: any) => ({
      id: j.id, title: j.title, steps: Array.isArray(j.steps) ? j.steps.map((s: any) => ({ title: String(s?.title ?? '') })) : [],
    }))
    const sceneNames = placeNames((scenesRes.data || []) as any[], (journeysRes.data || []) as any[])
    return reply.send({ enabled: true, ...summarizeVisits((eventsRes.data || []) as VisitEventRow[], journeys, sceneNames, query.days) })
  })
}
