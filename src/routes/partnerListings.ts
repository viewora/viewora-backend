import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AVAILABILITY, EXTERNAL_ID, MEDIA_KINDS, PUBLICATION_STATUSES, parseIfMatch } from '../partners/listingModel.js'
import { LISTING_RULES, parseListingId, stable, type Ctx, type ListingService, type Result } from '../partners/listingService.js'
import type { ListingStore, ListSort, WebhookRow } from '../partners/listingStore.js'
import type { PartnerStore } from '../partners/store.js'
import { assertPublicHost, SafeFetchError } from '../partners/safeFetch.js'
import { encryptSecret, EVENT_TYPES, generateWebhookSecret, MAX_WEBHOOKS, ROTATION_OVERLAP_MS, webhookKey } from '../partners/webhooks.js'
import type { ClaimService } from '../partners/claims.js'
import type { Scope } from '../partners/scopes.js'
import { rateKey } from '../partners/rateKey.js'

// /v1/listings and friends. Registered inside the partner API plugin, so
// key auth, scopes, rate limits and the error shape are shared with /v1/tours.

export type PartnerListingOptions = {
  service: ListingService
  listings: ListingStore
  partners: PartnerStore
  /** Tests replace the DNS check for webhook URLs. */
  checkHost?: (url: string) => Promise<void>
  webhookKey?: () => Buffer | null
  claims: ClaimService
  now?: () => number
}

const claimsQuery = z.object({ status: z.enum(['pending', 'approved', 'declined', 'cancelled', 'expired']).optional() }).strict()

const cfg = (max: number, scope: Scope) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: rateKey }, scope })

const SORTS = ['updated_at', '-updated_at', 'created_at', '-created_at'] as const

const listQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  external_id: EXTERNAL_ID.optional(),
  agent_external_id: EXTERNAL_ID.optional(),
  availability: z.enum(AVAILABILITY).optional(),
  publication_status: z.enum(PUBLICATION_STATUSES).optional(),
  updated_since: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(SORTS).default('-updated_at'),
}).strict()

const idParams = z.object({ id: z.string().min(1).max(130) })
const deleteBody = z.object({ reason: z.string().trim().max(200).optional(), confirm_bulk_delete: z.boolean().optional() }).strict()
const bulkBody = z.object({
  items: z.array(z.record(z.string(), z.unknown())).min(1),
  mode: z.literal('upsert').default('upsert'),
  dry_run: z.boolean().default(false),
}).strict()
const reconcileBody = z.object({
  items: z.array(z.object({ external_id: EXTERNAL_ID, version: z.number().int().min(1).optional() }).strict()).max(20_000),
}).strict()
const mediaBody = z.object({
  listing_id: z.string().min(1).max(130),
  kind: z.enum(MEDIA_KINDS),
  source_url: z.string().trim().url().max(2048),
  caption: z.string().trim().min(1).max(140).optional(),
  angle: z.number().int().min(0).max(359).optional(),
  order: z.number().int().min(0).max(1000).optional(),
}).strict()
const webhookBody = z.object({
  url: z.string().trim().url().max(2048),
  events: z.array(z.enum([...EVENT_TYPES, '*'] as [string, ...string[]])).min(1).max(30),
}).strict()
const leadsQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  listing_id: z.string().max(130).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
}).strict()
const analyticsQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  listing_id: z.string().max(130).optional(),
}).strict()
const exportQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

function fail(reply: FastifyReply, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return reply.code(status).send({ error: { code, message, ...(extra ?? {}) } })
}
const send = (reply: FastifyReply, r: Result) => reply.code(r.status).send(r.body)

function parse<T>(reply: FastifyReply, schema: z.ZodType<T>, input: unknown, code = 'VALIDATION_ERROR'): T | null {
  const r = schema.safeParse(input ?? {})
  if (r.success) return r.data
  fail(reply, 400, code, code === 'INVALID_FILTER' ? 'Unknown or invalid filter.' : 'Some fields are missing or invalid.', {
    fields: r.error.issues.map(i => ({ field: i.path.join('.') || 'body', message: i.message })),
  })
  return null
}

const encodeCursor = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
function decodeCursor<T>(raw: string | undefined): T | null | 'bad' {
  if (!raw) return null
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T } catch { return 'bad' }
}

const webhookOut = (w: WebhookRow) => ({
  id: `wh_${w.id}`, url: w.url, events: w.events, status: w.status, disabled_reason: w.disabled_reason,
  failing_since: w.failing_since, secret_prefix: w.secret_prefix, created_at: w.created_at,
  previous_secret_valid_until: w.prev_secret_expires_at && Date.parse(w.prev_secret_expires_at) > Date.now() ? w.prev_secret_expires_at : null,
})
const parseWebhookId = (raw: string) => /^wh_([0-9a-f-]{36})$/i.exec(raw)?.[1]?.toLowerCase() ?? null

export default async function partnerListingRoutes(fastify: FastifyInstance, opts: PartnerListingOptions) {
  const { service, listings, partners } = opts
  const checkHost = opts.checkHost ?? assertPublicHost
  const getKey = opts.webhookKey ?? (() => webhookKey())

  const ctx = (request: FastifyRequest): Ctx => {
    const p = request.partnerCtx!
    return { partner: p.partner, mode: p.mode, actor: { type: 'partner_key', id: p.keyId, requestId: String(request.id) } }
  }

  /**
   * Idempotency-Key: a retried request with the same key and body gets the
   * first answer back (kept 24 hours); the same key with another body is
   * refused. Server errors are not stored, so a retry runs again.
   */
  async function idempotent(request: FastifyRequest, reply: FastifyReply, run: () => Promise<Result>) {
    const raw = request.headers['idempotency-key']
    if (raw === undefined) return send(reply, await run())
    const key = Array.isArray(raw) ? raw[0] : raw
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) return fail(reply, 400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1 to 255 printable characters (a UUID is ideal).')
    const { partner, mode } = request.partnerCtx!
    const path = request.url.split('?')[0].slice(0, 300)
    const hash = createHash('sha256').update(`${request.method} ${path}\n${stable(request.body ?? null)}`).digest('hex')

    let existing = await listings.idemGet(partner.id, mode, key)
    if (existing && Date.parse(existing.expires_at) < Date.now()) {
      await listings.idemDelete(partner.id, mode, key)
      existing = null
    }
    if (existing) {
      if (existing.request_hash !== hash) return fail(reply, 422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request. Use a new key for a new request.')
      if (existing.status_code == null) return fail(reply, 409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running. Retry in a few seconds.')
      reply.header('idempotent-replayed', 'true')
      return reply.code(existing.status_code).send(existing.response)
    }
    if ((await listings.idemInsert(partner.id, mode, key, { method: request.method, path, request_hash: hash })) === 'exists') {
      return fail(reply, 409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running. Retry in a few seconds.')
    }
    let r: Result
    try { r = await run() } catch (e) { await listings.idemDelete(partner.id, mode, key).catch(() => {}); throw e }
    if (r.status >= 500) await listings.idemDelete(partner.id, mode, key).catch(() => {})
    else await listings.idemFinish(partner.id, mode, key, r.status, r.body)
    return send(reply, r)
  }

  // ── listings ──────────────────────────────────────────────────────────────

  fastify.post('/listings', { config: cfg(120, 'listings:write') }, (request, reply) =>
    idempotent(request, reply, () => service.create(ctx(request), request.body)))

  fastify.get('/listings', { config: cfg(300, 'listings:read') }, async (request, reply) => {
    const q = parse(reply, listQuery, request.query, 'INVALID_FILTER')
    if (!q) return
    const c = ctx(request)
    const cur = decodeCursor<{ t: string; id: string; s: ListSort }>(q.cursor)
    if (cur === 'bad' || (cur && (cur.s !== q.sort || typeof cur.t !== 'string' || typeof cur.id !== 'string'))) {
      return fail(reply, 400, 'INVALID_CURSOR', 'This cursor is not valid for this query. Start again without a cursor.')
    }
    let agentId: string | undefined
    if (q.agent_external_id) {
      const a = await partners.getAgent(c.partner.id, c.mode, q.agent_external_id)
      if (!a) return reply.send({ data: [], next_cursor: null })
      agentId = a.id
    }
    const rows = await listings.listStates({
      partnerId: c.partner.id, mode: c.mode, availability: q.availability, publicationStatus: q.publication_status,
      updatedSince: q.updated_since, externalId: q.external_id, agentId, sort: q.sort,
      after: cur ? { t: cur.t, id: cur.id } : undefined, limit: q.limit + 1,
    })
    const page = rows.slice(0, q.limit)
    const last = page[page.length - 1]
    const col = q.sort.replace('-', '') as 'updated_at' | 'created_at'
    const data = await service.outMany(page.map(r => ({ ref: r.ref, state: r })))
    return reply.send({ data, next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last[col], id: last.tour_ref_id, s: q.sort }) : null })
  })

  fastify.get('/listings/:id', { config: cfg(300, 'listings:read') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    return send(reply, await service.get(ctx(request), p.id))
  })

  fastify.patch('/listings/:id', { config: cfg(120, 'listings:write') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    const header = request.headers['if-match']
    const ifMatch = parseIfMatch(header)
    if (header !== undefined && ifMatch === null) return fail(reply, 400, 'INVALID_IF_MATCH', 'If-Match must be the listing version, for example 3 or "3".')
    return idempotent(request, reply, () => service.patch(ctx(request), p.id, request.body ?? {}, ifMatch))
  })

  fastify.delete('/listings/:id', { config: cfg(120, 'listings:write') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    const b = parse(reply, deleteBody, request.body ?? {})
    if (!b) return
    return idempotent(request, reply, () => service.archive(ctx(request), p.id, { reason: b.reason, confirmBulk: b.confirm_bulk_delete }))
  })

  fastify.post('/listings/:id/restore', { config: cfg(120, 'listings:write') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    return idempotent(request, reply, () => service.restore(ctx(request), p.id))
  })

  // ── bulk ──────────────────────────────────────────────────────────────────

  fastify.post('/listings/bulk', { config: cfg(10, 'listings:write'), bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const raw = request.body as any
    if (Array.isArray(raw?.items) && raw.items.length > LISTING_RULES.bulkMaxItems) {
      return fail(reply, 413, 'TOO_MANY_ITEMS', `Send at most ${LISTING_RULES.bulkMaxItems} items per request.`, { limit: LISTING_RULES.bulkMaxItems })
    }
    const b = parse(reply, bulkBody, raw)
    if (!b) return
    const c = ctx(request)
    return idempotent(request, reply, async () => {
      if ((await listings.countOpenImports(c.partner.id, c.mode)) >= LISTING_RULES.maxOpenImports) {
        return { status: 429, body: { error: { code: 'IMPORT_CONCURRENCY', message: 'You have 1 import running and 3 waiting. Wait for one to finish (GET /v1/imports/{id}).' } } }
      }
      const imp = await listings.insertImport({ partner_id: c.partner.id, mode: c.mode, key_id: c.actor.id, dry_run: b.dry_run, items: b.items, total: b.items.length })
      return { status: 202, body: { import_id: `imp_${imp.id}`, status: imp.status, dry_run: b.dry_run, items_received: imp.total, status_url: `/v1/imports/imp_${imp.id}` } }
    })
  })

  fastify.get('/imports/:id', { config: cfg(300, 'listings:read') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    const id = /^imp_([0-9a-f-]{36})$/i.exec(p.id)?.[1]?.toLowerCase()
    const { partner, mode } = request.partnerCtx!
    const imp = id ? await listings.getImport(id, partner.id, mode) : null
    if (!imp) return fail(reply, 404, 'IMPORT_NOT_FOUND', 'No import with this id for your account.')
    return reply.send({
      import_id: `imp_${imp.id}`, status: imp.status, dry_run: imp.dry_run,
      counts: { received: imp.total, processed: imp.cursor, ...imp.counts },
      errors: imp.errors, created_at: imp.created_at, started_at: imp.started_at, finished_at: imp.finished_at,
    })
  })

  // ── reconcile ─────────────────────────────────────────────────────────────
  // The partner sends every listing it thinks is active. Nothing is changed:
  // the answer lists what differs so the partner can fix it.
  fastify.post('/listings/reconcile', { config: cfg(10, 'listings:read'), bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const b = parse(reply, reconcileBody, request.body)
    if (!b) return
    const { partner, mode } = request.partnerCtx!
    const ours = await listings.listActiveVersions(partner.id, mode)
    const theirs = new Map(b.items.map(i => [i.external_id, i.version]))
    const oursByExt = new Map(ours.map(o => [o.external_id, o]))
    const cap = <T>(a: T[]) => a.slice(0, 1000)
    const notInYourList = ours.filter(o => !theirs.has(o.external_id)).map(o => ({ id: `lst_${o.tour_ref_id}`, external_id: o.external_id, version: o.version }))
    const unknown = b.items.filter(i => !oursByExt.has(i.external_id)).map(i => i.external_id)
    const behind = b.items.flatMap(i => {
      const o = oursByExt.get(i.external_id)
      return o && i.version !== undefined && o.version > i.version ? [{ external_id: i.external_id, your_version: i.version, current_version: o.version }] : []
    })
    return reply.send({
      checked: b.items.length,
      active_on_viewora: ours.length,
      not_in_your_list: cap(notInYourList),
      unknown_to_viewora: cap(unknown),
      version_behind: cap(behind),
      truncated: notInYourList.length > 1000 || unknown.length > 1000 || behind.length > 1000,
    })
  })

  // ── media ─────────────────────────────────────────────────────────────────
  // Adds one file by URL to a listing's media list; a worker fetches it.
  // Files on your computer: upload them to the listing's tour with
  // POST /v1/tours/{tour_id}/uploads.
  fastify.post('/media', { config: cfg(600, 'media:write') }, async (request, reply) => {
    const b = parse(reply, mediaBody, request.body)
    if (!b) return
    if (!b.source_url.startsWith('https://')) return fail(reply, 400, 'URL_NOT_HTTPS', 'source_url must be an https:// URL.')
    if (b.kind === 'car_exterior' && b.angle === undefined) return fail(reply, 400, 'VALIDATION_ERROR', 'car_exterior needs an angle (0 to 359).', { fields: [{ field: 'angle', message: 'Required' }] })
    const c = ctx(request)
    return idempotent(request, reply, async () => {
      const found = await service.resolve(c, b.listing_id)
      if (!found?.state) return { status: 404, body: { error: { code: 'LISTING_NOT_FOUND', message: 'No listing with this id for your account.' } } }
      const current = (found.state.listing.media ?? [])
      if (current.some(m => m.source_url === b.source_url)) {
        const rows = await listings.listMedia(found.ref.id)
        const row = rows.find(m => m.source_url === b.source_url)
        return { status: 200, body: { media: row ? { id: row.id, status: row.status } : null, created: false } }
      }
      const item = { kind: b.kind, source_url: b.source_url, ...(b.caption ? { caption: b.caption } : {}), ...(b.angle !== undefined ? { angle: b.angle } : {}), order: b.order ?? current.length }
      const r = await service.patch(c, b.listing_id, { media: [...current, item] }, null)
      if (r.status >= 400) return r
      const row = (await listings.listMedia(found.ref.id)).find(m => m.source_url === b.source_url)
      return { status: 202, body: { media: row ? { id: row.id, kind: row.kind, status: row.status } : null, listing_version: r.body?.listing?.version, created: true } }
    })
  })

  // ── webhooks ──────────────────────────────────────────────────────────────

  fastify.post('/webhooks', { config: cfg(30, 'webhooks:manage') }, async (request, reply) => {
    const b = parse(reply, webhookBody, request.body)
    if (!b) return
    if (!b.url.startsWith('https://')) return fail(reply, 400, 'URL_NOT_HTTPS', 'Webhook URLs must use https://.')
    const key = getKey()
    if (!key) return fail(reply, 503, 'WEBHOOKS_UNAVAILABLE', 'Webhooks are not switched on yet. Contact Viewora.')
    try { await checkHost(b.url) } catch (e) {
      const code = e instanceof SafeFetchError ? e.code : 'NETWORK'
      return fail(reply, 400, code === 'URL_PRIVATE_NETWORK' ? 'URL_PRIVATE_NETWORK' : code === 'URL_NOT_HTTPS' ? 'URL_NOT_HTTPS' : 'URL_UNREACHABLE',
        code === 'URL_PRIVATE_NETWORK' ? 'This URL points to a private network.' : 'The host name could not be found.')
    }
    const c = ctx(request)
    if ((await listings.listWebhooks(c.partner.id, c.mode)).length >= MAX_WEBHOOKS) {
      return fail(reply, 409, 'WEBHOOK_LIMIT', `You can have ${MAX_WEBHOOKS} webhook endpoints per mode. Delete one first.`)
    }
    const secret = generateWebhookSecret()
    const row = await listings.insertWebhook({
      partner_id: c.partner.id, mode: c.mode, url: b.url, events: [...new Set(b.events)],
      secret_cipher: encryptSecret(secret, key), secret_prefix: secret.slice(0, 10),
    })
    await listings.insertAudit({ partner_id: c.partner.id, mode: c.mode, actor_type: 'partner_key', actor_id: c.actor.id, action: 'webhook.created',
      entity_type: 'webhook', entity_id: row.id, changes: { url: [null, b.url] }, request_id: c.actor.requestId })
    return reply.code(201).send({ webhook: webhookOut(row), secret, note: 'Store this secret now. It is shown once and signs every delivery (Viewora-Signature header).' })
  })

  fastify.get('/webhooks', { config: cfg(120, 'webhooks:manage') }, async (request, reply) => {
    const { partner, mode } = request.partnerCtx!
    const rows = await listings.listWebhooks(partner.id, mode)
    return reply.send({ webhooks: rows.map(webhookOut) })
  })

  const loadWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return null
    const id = parseWebhookId(p.id)
    const { partner, mode } = request.partnerCtx!
    const w = id ? await listings.getWebhook(id) : null
    if (!w || w.partner_id !== partner.id || w.mode !== mode || w.deleted_at) {
      fail(reply, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with this id for your account.')
      return null
    }
    return w
  }

  fastify.get('/webhooks/:id/deliveries', { config: cfg(120, 'webhooks:manage') }, async (request, reply) => {
    const w = await loadWebhook(request, reply)
    if (!w) return
    const rows = await listings.deliveries({ webhookId: w.id, limit: 50 })
    return reply.send({ deliveries: rows.map(d => ({
      id: d.id, event_id: `evt_${d.event_id}`, status: d.status, attempts: d.attempts, last_status: d.last_status,
      last_error: d.last_error, next_attempt_at: d.status === 'pending' ? d.next_attempt_at : null, created_at: d.created_at, delivered_at: d.delivered_at,
    })) })
  })

  fastify.delete('/webhooks/:id', { config: cfg(30, 'webhooks:manage') }, async (request, reply) => {
    const w = await loadWebhook(request, reply)
    if (!w) return
    await listings.updateWebhook(w.id, { deleted_at: new Date().toISOString(), status: 'disabled' })
    const c = ctx(request)
    await listings.insertAudit({ partner_id: c.partner.id, mode: c.mode, actor_type: 'partner_key', actor_id: c.actor.id, action: 'webhook.deleted',
      entity_type: 'webhook', entity_id: w.id, changes: {}, request_id: c.actor.requestId })
    return reply.code(204).send()
  })

  fastify.post('/webhooks/:id/test', { config: cfg(30, 'webhooks:manage') }, async (request, reply) => {
    const w = await loadWebhook(request, reply)
    if (!w) return
    const { partner, mode } = request.partnerCtx!
    await listings.insertEvents(partner.id, mode, [{ event_type: 'webhook.test', payload: { webhook_id: `wh_${w.id}`, message: 'Test delivery from Viewora' } }])
    return reply.code(202).send({ queued: true, note: 'A webhook.test event is on its way. Check GET /v1/webhooks/{id}/deliveries.' })
  })

  // New signing secret. The old one keeps signing for 24 hours (both appear
  // as v1= in Viewora-Signature), so the partner can switch without a gap.
  fastify.post('/webhooks/:id/rotate-secret', { config: cfg(10, 'webhooks:manage') }, async (request, reply) => {
    const w = await loadWebhook(request, reply)
    if (!w) return
    const key = getKey()
    if (!key) return fail(reply, 503, 'WEBHOOKS_UNAVAILABLE', 'Webhooks are not switched on yet. Contact Viewora.')
    const secret = generateWebhookSecret()
    const until = new Date((opts.now ?? Date.now)() + ROTATION_OVERLAP_MS).toISOString()
    await listings.updateWebhook(w.id, {
      secret_cipher: encryptSecret(secret, key), secret_prefix: secret.slice(0, 10),
      prev_secret_cipher: w.secret_cipher, prev_secret_expires_at: until,
    })
    const c = ctx(request)
    await listings.insertAudit({ partner_id: c.partner.id, mode: c.mode, actor_type: 'partner_key', actor_id: c.actor.id, action: 'webhook.secret_rotated',
      entity_type: 'webhook', entity_id: w.id, changes: { secret_prefix: [w.secret_prefix, secret.slice(0, 10)] }, request_id: c.actor.requestId })
    return reply.send({
      webhook: webhookOut({ ...w, secret_prefix: secret.slice(0, 10), prev_secret_expires_at: until }), secret,
      note: `Store this secret now. Until ${until} each delivery is signed with both the new and the old secret.`,
    })
  })

  fastify.post('/webhooks/:id/enable', { config: cfg(30, 'webhooks:manage') }, async (request, reply) => {
    const w = await loadWebhook(request, reply)
    if (!w) return
    await listings.updateWebhook(w.id, { status: 'active', disabled_reason: null, failing_since: null })
    return reply.send({ webhook: webhookOut({ ...w, status: 'active', disabled_reason: null, failing_since: null }) })
  })

  // ── leads ─────────────────────────────────────────────────────────────────
  // Contact details of people who asked about the partner's own listings.
  // leads:read is granted by staff only after the data-processing addendum.
  fastify.get('/leads', { config: cfg(60, 'leads:read') }, async (request, reply) => {
    const q = parse(reply, leadsQuery, request.query, 'INVALID_FILTER')
    if (!q) return
    const c = ctx(request)
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor)
    if (cur === 'bad') return fail(reply, 400, 'INVALID_CURSOR', 'This cursor is not valid. Start again without a cursor.')
    let spaceId: string | undefined
    if (q.listing_id) {
      const found = await service.resolve(c, q.listing_id)
      if (!found) return fail(reply, 404, 'LISTING_NOT_FOUND', 'No listing with this id for your account.')
      spaceId = found.ref.space_id
    }
    const rows = await listings.leads(c.partner.id, c.mode, { spaceId, since: q.since, after: cur ?? undefined, limit: q.limit + 1 })
    const page = rows.slice(0, q.limit)
    await listings.insertAudit({ partner_id: c.partner.id, mode: c.mode, actor_type: 'partner_key', actor_id: c.actor.id, action: 'leads.read',
      entity_type: 'lead', entity_id: null, changes: { count: [null, page.length] }, request_id: c.actor.requestId })
    const last = page[page.length - 1]
    return reply.send({
      data: page.map(l => ({
        id: `lead_${l.id}`, listing_id: l.ref.id ? `lst_${l.ref.id}` : null, external_id: l.ref.external_id ?? null,
        name: l.name, email: l.email, phone: l.phone, message: l.message, source: l.source, created_at: l.created_at,
        // The words the buyer agreed to, and when. Leads without this are never shared.
        consent: { wording: l.consent.wording, given_at: l.consent.given_at },
      })),
      next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
    })
  })

  // ── analytics ─────────────────────────────────────────────────────────────
  fastify.get('/analytics', { config: cfg(60, 'analytics:read') }, async (request, reply) => {
    const q = parse(reply, analyticsQuery, request.query, 'INVALID_FILTER')
    if (!q) return
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400_000
    if (days < 0) return fail(reply, 400, 'INVALID_FILTER', '"from" must be on or before "to".')
    if (days > 91) return fail(reply, 400, 'RANGE_TOO_LARGE', 'Ask for at most 92 days at a time.')
    const c = ctx(request)
    let spaceId: string | undefined
    if (q.listing_id) {
      const found = await service.resolve(c, q.listing_id)
      if (!found) return fail(reply, 404, 'LISTING_NOT_FOUND', 'No listing with this id for your account.')
      spaceId = found.ref.space_id
    }
    const rows = await listings.analytics(c.partner.id, c.mode, { from: q.from, to: q.to, spaceId })
    return reply.send({
      from: q.from, to: q.to,
      series: rows.map(r => ({ listing_id: r.ref.id ? `lst_${r.ref.id}` : null, external_id: r.ref.external_id ?? null, date: r.date, views: r.counts.total_views ?? 0, ...r.counts })),
    })
  })

  // ── claims: link a tour an agent made in the Viewora app ─────────────────
  const { claims } = opts
  const sendResult = (reply: FastifyReply, r: Result) => reply.code(r.status).send(r.body)

  fastify.post('/claims', { config: cfg(60, 'listings:write') }, async (request, reply) =>
    sendResult(reply, await claims.request(ctx(request), request.body)))

  fastify.get('/claims', { config: cfg(120, 'listings:read') }, async (request, reply) => {
    const q = parse(reply, claimsQuery, request.query ?? {}, 'INVALID_FILTER')
    if (!q) return
    return sendResult(reply, await claims.list(ctx(request), q.status))
  })

  fastify.get('/claims/:id', { config: cfg(120, 'listings:read') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    return sendResult(reply, await claims.get(ctx(request), p.id))
  })

  fastify.delete('/claims/:id', { config: cfg(60, 'listings:write') }, async (request, reply) => {
    const p = parse(reply, idParams, request.params)
    if (!p) return
    return sendResult(reply, await claims.cancel(ctx(request), p.id))
  })

  // ── export (Viewora → partner, read-only) ────────────────────────────────
  // Every published tour of the partner's agents, including ones the agent
  // made in the Viewora app. Read-only: the agreement says partners must not
  // edit these on their side and send them back.
  fastify.get('/export/listings', { config: cfg(120, 'listings:read') }, async (request, reply) => {
    const q = parse(reply, exportQuery, request.query, 'INVALID_FILTER')
    if (!q) return
    const { partner, mode } = request.partnerCtx!
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor)
    if (cur === 'bad') return fail(reply, 400, 'INVALID_CURSOR', 'This cursor is not valid. Start again without a cursor.')
    const spaces = await listings.exportSpaces(partner.id, mode, { after: cur ?? undefined, limit: q.limit + 1 })
    const page = spaces.slice(0, q.limit)
    const agents = await listings.agentsByUsers(partner.id, mode, [...new Set(page.map(s => s.user_id))])
    const byUser = new Map(agents.map(a => [a.user_id, a]))
    const refs = await Promise.all(page.map(s => partners.getTourRef(partner.id, mode, { spaceId: s.id })))
    const appUrl = (process.env.APP_URL ?? 'https://app.viewora.software').replace(/\/$/, '')
    const last = page[page.length - 1]
    return reply.send({
      data: page.map((s, i) => ({
        tour_id: s.id,
        listing_id: refs[i] ? `lst_${refs[i]!.id}` : null,
        external_id: refs[i]?.external_id ?? null,
        origin: refs[i] ? 'partner' : 'viewora',
        agent_external_id: byUser.get(s.user_id)?.external_id ?? null,
        title: s.title, type: s.property_type, location_text: s.location_text,
        price_kes: s.price_kes, listing_status: s.listing_status, transaction_type: s.transaction_type, price_period: s.price_period,
        bedrooms: s.bedrooms, bathrooms: s.bathrooms, cover_image_url: s.cover_image_url,
        urls: s.slug ? { share: `${appUrl}/p/${s.slug}`, embed: `${appUrl}/embed/${s.slug}` } : { share: null, embed: null },
        updated_at: s.updated_at,
      })),
      next_cursor: spaces.length > q.limit && last ? encodeCursor({ t: last.updated_at, id: last.id }) : null,
    })
  })
}

export { parseListingId }
