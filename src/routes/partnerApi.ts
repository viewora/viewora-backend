import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { hashPartnerKey, parsePartnerKey, type KeyMode } from '../utils/partnerKeys.js'
import { unwrapEnvelope } from '../utils/ownShapeRoutes.js'
import { supabaseStore, type AgentRow, type KeyRecord, type Partner, type PartnerStore, type SpaceSummary, type TourRefRow } from '../partners/store.js'

// Partner API (/v1): property and car apps create tours for their agents.
//
// Each agent is a real Viewora account. Every tour action is run AS that
// agent through the existing routes (fastify.inject with the in-process
// internal key), so plan limits, quotas, file checks, ownership checks and
// processing are exactly the same as in the dashboard. This file only adds
// partner auth, the partner's own ids, and a stable response shape.

export type InternalResult = { status: number; body: any }
export type CallAs = (userId: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<InternalResult>

export type PartnerApiOptions = {
  store?: PartnerStore
  callAs?: CallAs
  appUrl?: string
  mediaBaseUrl?: string
}

type PartnerContext = { keyId: string; mode: KeyMode; partner: Partner }

declare module 'fastify' {
  interface FastifyRequest {
    partnerCtx?: PartnerContext
  }
}

const EXTERNAL_ID = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:\-]+$/, 'Use letters, numbers, dot, dash, underscore or colon')
const SPACE_TYPES = ['residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other'] as const
const FACT_KEYS = [
  'price_kes', 'listing_status', 'transaction_type', 'price_period', 'bedrooms', 'bathrooms', 'area_sqm',
  'vehicle_year', 'vehicle_mileage_km', 'vehicle_transmission', 'vehicle_fuel_type', 'land_acres', 'land_type', 'amenities',
] as const

const createAgentBody = z.object({
  external_id: EXTERNAL_ID,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
})

const createTourBody = z.object({
  agent_external_id: EXTERNAL_ID,
  external_id: EXTERNAL_ID,
  title: z.string().trim().min(1).max(120),
  type: z.enum(SPACE_TYPES),
  description: z.string().max(2000).optional(),
  location_text: z.string().max(200).optional(),
  // Listing facts are checked by the same rules as the dashboard.
  details: z.record(z.string(), z.unknown()).optional(),
})

const listQuery = z.object({
  external_id: EXTERNAL_ID.optional(),
  agent_external_id: EXTERNAL_ID.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

const tourParams = z.object({ id: z.string().uuid() })
const agentParams = z.object({ externalId: EXTERNAL_ID })

const UPLOAD_KINDS = ['panorama', 'photo', 'car_exterior'] as const
const KIND_TO_MEDIA: Record<typeof UPLOAD_KINDS[number], string> = {
  panorama: 'panorama',
  photo: 'gallery_image',
  car_exterior: 'vehicle_view',
}

const createUploadBody = z.object({
  kind: z.enum(UPLOAD_KINDS),
  file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(120),
  file_size: z.number().int().positive().max(250_000_000),
})

const completeUploadBody = z.object({
  kind: z.enum(UPLOAD_KINDS),
  upload_key: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(100).optional(),
  angle: z.number().int().min(0).max(359).optional(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
}).superRefine((d, ctx) => {
  if (d.kind === 'car_exterior' && d.angle === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['angle'], message: 'angle (0–359) is required for car_exterior photos' })
  }
})

// ── helpers ─────────────────────────────────────────────────────────────────

function fail(reply: FastifyReply, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return reply.code(status).send({ error: { code, message, ...(extra ?? {}) } })
}

function parse<T>(reply: FastifyReply, schema: z.ZodType<T>, input: unknown): T | null {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  fail(reply, 400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', {
    fields: r.error.issues.map(i => ({ field: i.path.join('.') || 'body', message: i.message })),
  })
  return null
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
  413: 'FILE_TOO_LARGE', 429: 'RATE_LIMITED',
}

/** Passes an inner route's error on in the partner API's error shape. */
function forward(reply: FastifyReply, res: InternalResult, fallback: string) {
  const b = res.body ?? {}
  const status = res.status >= 400 ? res.status : 502
  const code = b.code || b.error?.code || STATUS_CODES[status] || 'INTERNAL_ERROR'
  const message = b.statusMessage || b.error?.message || (typeof b.message === 'string' ? b.message : null) || fallback
  return fail(reply, status, code, message, b.fields ? { fields: b.fields } : undefined)
}

function rateKey(req: FastifyRequest) {
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer vo_') ? `pk:${hashPartnerKey(auth.slice(7).trim()).slice(0, 24)}` : req.ip
}

const rl = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: rateKey } })

function todayEAT(now = Date.now()) {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10)
}

// ── plugin ──────────────────────────────────────────────────────────────────

export default async function partnerApi(fastify: FastifyInstance, opts: PartnerApiOptions = {}) {
  const store = opts.store ?? supabaseStore(fastify)
  const appUrl = (opts.appUrl ?? process.env.APP_URL ?? 'https://app.viewora.software').replace(/\/$/, '')
  const mediaBase = (opts.mediaBaseUrl ?? process.env.MEDIA_DOMAIN ?? `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`).replace(/\/$/, '')

  const callAs: CallAs = opts.callAs ?? (async (userId, method, url, payload) => {
    const res = await fastify.inject({
      method,
      url,
      payload: payload as any,
      // Gives each agent its own bucket in the existing per-route rate limits.
      remoteAddress: `partner-agent:${userId}`,
      headers: {
        'x-internal-api-key': process.env.INTERNAL_API_KEY as string,
        'x-internal-user-id': userId,
      },
    })
    let body: any = {}
    try { body = res.json() } catch { body = {} }
    // Inner routes answer in the global { success, data } envelope.
    return { status: res.statusCode, body: unwrapEnvelope(body) }
  })

  const redis = () => (fastify as any).redis as { get: Function; setEx: Function; del: Function; incr: Function; expire: Function } | null | undefined

  // ── partner key auth ──────────────────────────────────────────────────────
  fastify.addHook('preHandler', async (request, reply) => {
    const parsed = parsePartnerKey(request.headers.authorization)
    if (!parsed) return fail(reply, 401, 'UNAUTHORIZED', 'Send your API key as "Authorization: Bearer vo_live_…" or "vo_test_…".')
    const hash = hashPartnerKey(parsed.key)
    const cacheKey = `partnerkey:${hash}`

    let rec: KeyRecord | null = null
    const r = redis()
    if (r) {
      try { const c = await r.get(cacheKey); if (c) rec = JSON.parse(c) } catch { /* fall through */ }
    }
    if (!rec) {
      try { rec = await store.findKeyByHash(hash) } catch (err: any) {
        request.log.error({ err: err?.message }, 'partner key lookup failed')
        return fail(reply, 503, 'UNAVAILABLE', 'We could not check your key right now. Please retry in a minute.')
      }
      if (rec) {
        void store.touchKey(rec.keyId).catch(() => {})
        if (r) void Promise.resolve(r.setEx(cacheKey, 60, JSON.stringify(rec))).catch(() => {})
      }
    }
    if (!rec || rec.revoked || rec.mode !== parsed.mode) return fail(reply, 401, 'UNAUTHORIZED', 'This API key is not valid or has been revoked.')
    if (rec.partner.status !== 'active') return fail(reply, 403, 'PARTNER_SUSPENDED', 'This partner account is suspended. Contact Viewora.')

    request.partnerCtx = { keyId: rec.keyId, mode: rec.mode, partner: rec.partner }
    request.log.info({ partner: rec.partner.slug, keyId: rec.keyId, mode: rec.mode }, 'partner api request')
  })

  // ── shaping ───────────────────────────────────────────────────────────────
  const agentOut = (a: AgentRow) => ({ external_id: a.external_id, name: a.name, created_at: a.created_at })

  async function toursOut(refs: TourRefRow[]) {
    const [spaces, agents] = await Promise.all([
      store.getSpaces(refs.map(r => r.space_id)),
      store.getAgentsByIds([...new Set(refs.map(r => r.agent_id))]),
    ])
    const sById = new Map(spaces.map(s => [s.id, s]))
    const aById = new Map(agents.map(a => [a.id, a]))
    return refs.flatMap(ref => {
      const s = sById.get(ref.space_id)
      if (!s) return []
      return [tourOut(ref, s, aById.get(ref.agent_id))]
    })
  }

  function tourOut(ref: TourRefRow, s: SpaceSummary, agent?: AgentRow) {
    const live = s.is_published && !!s.slug
    return {
      id: s.id,
      external_id: ref.external_id,
      agent_external_id: agent?.external_id ?? null,
      mode: ref.mode,
      title: s.title,
      type: s.property_type,
      status: s.is_published ? 'published' : 'draft',
      has_360: Boolean(s.has_360),
      has_photos: Boolean(s.has_gallery),
      cover_image_url: s.cover_image_url,
      embed_url: live ? `${appUrl}/embed/${s.slug}` : null,
      share_url: live ? `${appUrl}/p/${s.slug}` : null,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }
  }

  /** Loads the tour for this partner + mode and the agent who owns it, or replies 404. */
  async function loadTour(request: FastifyRequest, reply: FastifyReply) {
    const params = parse(reply, tourParams, request.params)
    if (!params) return null
    const { partner, mode } = request.partnerCtx!
    const ref = await store.getTourRef(partner.id, mode, { spaceId: params.id })
    const agent = ref ? (await store.getAgentsByIds([ref.agent_id]))[0] : undefined
    if (!ref || !agent) {
      fail(reply, 404, 'TOUR_NOT_FOUND', 'No tour with this id for your account.')
      return null
    }
    return { ref, agent }
  }

  // ── agents ────────────────────────────────────────────────────────────────

  fastify.post('/agents', { config: rl(60) }, async (request, reply) => {
    const body = parse(reply, createAgentBody, request.body)
    if (!body) return
    const { partner, mode } = request.partnerCtx!

    const existing = await store.getAgent(partner.id, mode, body.external_id)
    if (existing) return reply.code(200).send({ agent: agentOut(existing), created: false })

    // Live seats are what the partner paid for. Test agents don't use seats.
    if (mode === 'live' && partner.max_agents != null && (await store.countAgents(partner.id, 'live')) >= partner.max_agents) {
      return fail(reply, 403, 'AGENT_LIMIT_REACHED', `Your account includes ${partner.max_agents} agents. Contact Viewora to add more.`, { limit: partner.max_agents })
    }
    if (mode === 'live' && !body.email) {
      return fail(reply, 400, 'VALIDATION_ERROR', 'email is required for live agents. It becomes their Viewora login.', {
        fields: [{ field: 'email', message: 'Required' }],
      })
    }
    // Test agents never take a real person's email, so testing can't block
    // the real account later. No email is ever sent on account creation.
    const email = mode === 'live' ? body.email! : `test-agent-${randomUUID()}@partners-test.viewora.software`

    const created = await store.createAuthUser({ email, name: body.name, partnerSlug: partner.slug })
    if ('error' in created) {
      if (created.error === 'email_in_use') {
        return fail(reply, 409, 'EMAIL_IN_USE', 'This email already has a Viewora account. Linking an existing account needs the owner\'s consent and is not available yet; use another email or contact Viewora.')
      }
      return fail(reply, 502, 'ACCOUNT_CREATE_FAILED', 'We could not create the agent account. Please retry.')
    }

    const row = await store.insertAgent({ partner_id: partner.id, mode, external_id: body.external_id, user_id: created.userId, name: body.name })
    if (row === 'duplicate') {
      // Lost a race with a parallel request for the same agent: keep theirs.
      await store.deleteAuthUser(created.userId)
      const winner = await store.getAgent(partner.id, mode, body.external_id)
      return reply.code(200).send({ agent: winner ? agentOut(winner) : null, created: false })
    }
    // The partner pays: put the agent on the partner's plan. A failure here
    // is logged and retried by the next staff sync; the agent still exists.
    await store.syncAgentPlan(partner, created.userId).catch(err => request.log.error({ err: err?.message }, 'agent plan sync failed'))
    return reply.code(201).send({ agent: agentOut(row), created: true })
  })

  fastify.get('/agents', { config: rl(300) }, async (request, reply) => {
    const q = parse(reply, listQuery.pick({ limit: true, offset: true }), request.query)
    if (!q) return
    const { partner, mode } = request.partnerCtx!
    const rows = await store.listAgents(partner.id, mode, q.limit, q.offset)
    return reply.send({ agents: rows.map(agentOut), limit: q.limit, offset: q.offset })
  })

  fastify.get('/agents/:externalId', { config: rl(300) }, async (request, reply) => {
    const p = parse(reply, agentParams, request.params)
    if (!p) return
    const { partner, mode } = request.partnerCtx!
    const a = await store.getAgent(partner.id, mode, p.externalId)
    if (!a) return fail(reply, 404, 'AGENT_NOT_FOUND', 'No agent with this external_id. Create it with POST /v1/agents first.')
    return reply.send({ agent: agentOut(a) })
  })

  // ── tours ─────────────────────────────────────────────────────────────────

  fastify.post('/tours', { config: rl(120) }, async (request, reply) => {
    const body = parse(reply, createTourBody, request.body)
    if (!body) return
    const { partner, mode } = request.partnerCtx!

    const agent = await store.getAgent(partner.id, mode, body.agent_external_id)
    if (!agent) return fail(reply, 404, 'AGENT_NOT_FOUND', 'No agent with this agent_external_id. Create it with POST /v1/agents first.')

    const existing = await store.getTourRef(partner.id, mode, { externalId: body.external_id })
    if (existing) {
      const [tour] = await toursOut([existing])
      return fail(reply, 409, 'TOUR_EXISTS', 'A tour with this external_id already exists.', { tour })
    }

    const facts: Record<string, unknown> = {}
    for (const k of FACT_KEYS) if (body.details && k in body.details) facts[k] = body.details[k]

    const res = await callAs(agent.user_id, 'POST', '/spaces', {
      title: body.title,
      space_type: body.type,
      description: body.description,
      location_text: body.location_text,
      ...facts,
    })
    if (res.status !== 201) return forward(reply, res, 'Could not create the tour.')
    const spaceId = res.body?.id as string

    const ref = await store.insertTourRef({ partner_id: partner.id, mode, external_id: body.external_id, space_id: spaceId, agent_id: agent.id })
    if (ref === 'duplicate') {
      await callAs(agent.user_id, 'DELETE', `/spaces/${spaceId}`)
      const winner = await store.getTourRef(partner.id, mode, { externalId: body.external_id })
      const [tour] = winner ? await toursOut([winner]) : [null]
      return fail(reply, 409, 'TOUR_EXISTS', 'A tour with this external_id already exists.', { tour })
    }
    const [tour] = await toursOut([ref])
    return reply.code(201).send({ tour })
  })

  fastify.get('/tours', { config: rl(300) }, async (request, reply) => {
    const q = parse(reply, listQuery, request.query)
    if (!q) return
    const { partner, mode } = request.partnerCtx!

    if (q.external_id) {
      const ref = await store.getTourRef(partner.id, mode, { externalId: q.external_id })
      return reply.send({ tours: ref ? await toursOut([ref]) : [], limit: q.limit, offset: q.offset })
    }
    let agentId: string | undefined
    if (q.agent_external_id) {
      const a = await store.getAgent(partner.id, mode, q.agent_external_id)
      if (!a) return reply.send({ tours: [], limit: q.limit, offset: q.offset })
      agentId = a.id
    }
    const refs = await store.listTourRefs(partner.id, mode, { agentId, limit: q.limit, offset: q.offset })
    return reply.send({ tours: await toursOut(refs), limit: q.limit, offset: q.offset })
  })

  fastify.get('/tours/:id', { config: rl(300) }, async (request, reply) => {
    const t = await loadTour(request, reply)
    if (!t) return
    const [tour] = await toursOut([t.ref])
    if (!tour) return fail(reply, 404, 'TOUR_NOT_FOUND', 'No tour with this id for your account.')
    return reply.send({ tour })
  })

  const setPublished = (publish: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const t = await loadTour(request, reply)
    if (!t) return
    const res = await callAs(t.agent.user_id, 'POST', `/spaces/${t.ref.space_id}/publish`, { publish })
    if (res.status !== 200) return forward(reply, res, publish ? 'Could not publish the tour.' : 'Could not unpublish the tour.')
    const [tour] = await toursOut([t.ref])
    return reply.send({ tour })
  }
  fastify.post('/tours/:id/publish', { config: rl(120) }, setPublished(true))
  fastify.post('/tours/:id/unpublish', { config: rl(120) }, setPublished(false))

  fastify.delete('/tours/:id', { config: rl(120) }, async (request, reply) => {
    const t = await loadTour(request, reply)
    if (!t) return
    const res = await callAs(t.agent.user_id, 'DELETE', `/spaces/${t.ref.space_id}`)
    if (res.status >= 300 && res.status !== 404) return forward(reply, res, 'Could not delete the tour.')
    await store.deleteTourRef(t.ref.id)
    return reply.code(204).send()
  })

  // ── uploads ───────────────────────────────────────────────────────────────
  // 1. POST /tours/:id/uploads           → a signed URL; PUT the file to it.
  // 2. POST /tours/:id/uploads/complete  → processing starts; a panorama
  //    becomes a 360 scene, a car_exterior photo joins the car's spin.

  fastify.post('/tours/:id/uploads', { config: rl(600) }, async (request, reply) => {
    const t = await loadTour(request, reply)
    if (!t) return
    const body = parse(reply, createUploadBody, request.body)
    if (!body) return
    const { partner } = request.partnerCtx!

    const r = redis()
    if (r) {
      const dayKey = `partner:uploads:${partner.id}:${todayEAT()}`
      try {
        const n = Number(await r.incr(dayKey))
        if (n === 1) void Promise.resolve(r.expire(dayKey, 2 * 86400)).catch(() => {})
        if (n > partner.daily_upload_cap) {
          return fail(reply, 429, 'DAILY_UPLOAD_CAP', `Your account can start ${partner.daily_upload_cap} uploads a day. This resets at midnight EAT.`)
        }
      } catch (err: any) {
        request.log.warn({ err: err?.message }, 'partner daily upload counter unavailable')
      }
    }

    const res = await callAs(t.agent.user_id, 'POST', '/uploads/create-signed-url', {
      spaceId: t.ref.space_id,
      mediaType: KIND_TO_MEDIA[body.kind],
      fileName: body.file_name,
      contentType: body.content_type,
      fileSize: body.file_size,
    })
    if (res.status !== 200) return forward(reply, res, 'Could not start the upload.')
    return reply.code(201).send({
      upload_key: res.body.objectKey,
      upload_url: res.body.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': body.content_type },
      expires_in: 900,
    })
  })

  fastify.post('/tours/:id/uploads/complete', { config: rl(600) }, async (request, reply) => {
    const t = await loadTour(request, reply)
    if (!t) return
    const body = parse(reply, completeUploadBody, request.body)
    if (!body) return

    // Only keys we issued for this tour's folder. Stops a partner pointing
    // at another tour's files even within the same agent.
    if (!body.upload_key.startsWith(`users/${t.agent.user_id}/spaces/${t.ref.space_id}/`) || body.upload_key.includes('..')) {
      return fail(reply, 400, 'INVALID_UPLOAD_KEY', 'upload_key does not belong to this tour. Use the key returned when the upload was started.')
    }
    const publicUrl = `${mediaBase}/${body.upload_key}`

    const done = await callAs(t.agent.user_id, 'POST', '/uploads/complete', {
      spaceId: t.ref.space_id,
      mediaType: KIND_TO_MEDIA[body.kind],
      objectKey: body.upload_key,
      publicUrl,
      width: body.width,
      height: body.height,
      client_event_id: `partner:${body.upload_key}`.slice(0, 255),
    })
    if (done.status !== 200) return forward(reply, done, 'Could not finish the upload.')
    const mediaId = done.body?.id as string | undefined

    if (body.kind === 'panorama' && !(await store.sceneExists(t.ref.space_id, publicUrl))) {
      const scene = await callAs(t.agent.user_id, 'POST', `/spaces/${t.ref.space_id}/scenes`, {
        name: body.name ?? 'Scene',
        raw_image_url: publicUrl,
      })
      if (scene.status !== 201) return forward(reply, scene, 'The file was saved but could not be turned into a 360 scene.')
    }
    if (body.kind === 'car_exterior' && !(await store.vehicleViewExists(t.ref.space_id, publicUrl))) {
      const view = await callAs(t.agent.user_id, 'POST', `/spaces/${t.ref.space_id}/vehicle-views`, {
        image_url: publicUrl,
        media_id: mediaId ?? null,
        angle: body.angle,
        label: body.name ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
      })
      if (view.status !== 201) return forward(reply, view, 'The file was saved but could not be added to the car.')
    }

    return reply.send({ upload: { upload_key: body.upload_key, kind: body.kind, status: 'processing' } })
  })
}
