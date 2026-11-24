import { createHash } from 'node:crypto'
import type { ListingStore, MediaRow, OutboxRow, WebhookRow } from './listingStore.js'
import type { ListingService, Ctx } from './listingService.js'
import { FETCHED_KINDS } from './listingService.js'
import type { PartnerStore } from './store.js'
import type { TourGateway } from './tourGateway.js'
import { SafeFetchError, type SafeFetch } from './safeFetch.js'
import { decryptSecret, DISABLE_AFTER_MS, eventBody, nextAttemptDelayMs, signPayload, subscribed } from './webhooks.js'

// Background work for the listing platform, off the request path. Every
// job reads its work from Postgres (outbox, deliveries, media, imports), so
// nothing is lost if Redis or the process restarts; rows are claimed with a
// short lock so two API replicas never do the same item twice.

export type JobDeps = {
  listings: ListingStore
  partners: PartnerStore
  service: ListingService
  tours: TourGateway
  fetch: SafeFetch
  webhookKey: () => Buffer | null
  redis?: { incr: Function; expire: Function } | null
  log?: { info: Function; warn: Function; error: Function }
  now?: () => number
}

const nowMs = (d: JobDeps) => (d.now ? d.now() : Date.now())
const iso = (ms: number) => new Date(ms).toISOString()

/** Media fetch limits from the strategy doc. */
export const MEDIA_LIMITS = {
  maxBytes: { panorama: 60 * 1048576, default: 25 * 1048576 } as Record<string, number>,
  timeoutMs: 20_000,
  types: ['image/jpeg', 'image/png', 'image/webp'],
  /** Transient failures: 5 tries (30 s, 2 min, 10 min, 30 min, 2 h). */
  retryDelaysS: [30, 120, 600, 1800, 7200],
  perTick: 5,
}

// ── webhooks: outbox → deliveries ───────────────────────────────────────────

export async function dispatchEvents(d: JobDeps): Promise<number> {
  const events = await d.listings.undispatched(100)
  if (!events.length) return 0
  const hooks = new Map<string, WebhookRow[]>()
  const rows: { webhook_id: string; event_id: string; partner_id: string }[] = []
  for (const ev of events) {
    if (ev.event_type === 'webhook.test') {
      const id = String(ev.payload?.webhook_id ?? '').replace(/^wh_/, '')
      const w = id ? await d.listings.getWebhook(id) : null
      if (w && w.partner_id === ev.partner_id && w.mode === ev.mode && !w.deleted_at) rows.push({ webhook_id: w.id, event_id: ev.id, partner_id: ev.partner_id })
      continue
    }
    const k = `${ev.partner_id}:${ev.mode}`
    if (!hooks.has(k)) hooks.set(k, await d.listings.listWebhooks(ev.partner_id, ev.mode))
    for (const w of hooks.get(k)!) {
      if (w.status === 'active' && subscribed(w.events, ev.event_type)) rows.push({ webhook_id: w.id, event_id: ev.id, partner_id: ev.partner_id })
    }
  }
  await d.listings.insertDeliveries(rows)
  await d.listings.markDispatched(events.map(e => e.id))
  return events.length
}

export async function deliverWebhooks(d: JobDeps): Promise<number> {
  const now = nowMs(d)
  const due = await d.listings.claimDueDeliveries(iso(now), 20)
  const key = d.webhookKey()
  for (const del of due) {
    const [w, ev] = await Promise.all([d.listings.getWebhook(del.webhook_id), d.listings.getEvent(del.event_id)])
    const isTest = ev?.event_type === 'webhook.test'
    if (!w || !ev || w.deleted_at || (w.status !== 'active' && !isTest)) {
      await d.listings.updateDelivery(del.id, { status: 'discarded', locked_until: null })
      continue
    }
    if (!key) {
      d.log?.error({}, 'PARTNER_WEBHOOK_KEY is not set: webhook deliveries are paused')
      return 0
    }
    const result = await sendOne(d, w, ev, key)
    const attempts = del.attempts + 1
    if (result.ok) {
      await d.listings.updateDelivery(del.id, { status: 'succeeded', attempts, last_status: result.status, last_error: null, delivered_at: iso(nowMs(d)), locked_until: null })
      if (w.failing_since) await d.listings.updateWebhook(w.id, { failing_since: null })
      continue
    }
    const wait = nextAttemptDelayMs(attempts)
    await d.listings.updateDelivery(del.id, wait === null
      ? { status: 'dead', attempts, last_status: result.status, last_error: result.error, locked_until: null }
      : { attempts, last_status: result.status, last_error: result.error, next_attempt_at: iso(nowMs(d) + wait), locked_until: null })
    if (isTest) continue
    if (!w.failing_since) await d.listings.updateWebhook(w.id, { failing_since: iso(now) })
    else if (now - Date.parse(w.failing_since) > DISABLE_AFTER_MS) {
      // Emailing the partner's technical contact is left to staff for now (no automatic messages).
      await d.listings.updateWebhook(w.id, { status: 'disabled', disabled_reason: 'Failed without a success for 3 days. Fix the endpoint, then POST /v1/webhooks/{id}/enable.' })
      d.log?.warn({ webhook: w.id, partner: w.partner_id }, 'partner webhook disabled after 3 days of failures')
    }
  }
  return due.length
}

async function sendOne(d: JobDeps, w: WebhookRow, ev: OutboxRow, key: Buffer): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  let secret: string
  try { secret = decryptSecret(w.secret_cipher, key) } catch {
    return { ok: false, status: null, error: 'Signing secret could not be read (key changed?)' }
  }
  const body = eventBody(ev)
  try {
    const res = await d.fetch(w.url, {
      method: 'POST', body, timeoutMs: 10_000, maxBytes: 64 * 1024,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Viewora-Webhooks/1',
        'viewora-event-id': `evt_${ev.id}`,
        'viewora-event-type': ev.event_type,
        'viewora-signature': signPayload(secret, body, Math.floor(nowMs(d) / 1000)),
      },
    })
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null }
    return { ok: false, status: res.status, error: `Endpoint answered ${res.status}` }
  } catch (e: any) {
    return { ok: false, status: null, error: (e instanceof SafeFetchError ? e.message : 'The connection failed').slice(0, 300) }
  }
}

// ── media by URL ────────────────────────────────────────────────────────────

function todayEAT(ms: number) { return new Date(ms + 3 * 3600_000).toISOString().slice(0, 10) }
function nextMidnightEAT(ms: number) {
  const eat = new Date(ms + 3 * 3600_000)
  return Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() + 1) - 3 * 3600_000
}

const fileNameFor = (m: MediaRow, contentType: string) => {
  const last = decodeURIComponent(new URL(m.source_url).pathname.split('/').pop() || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
  return /\.(jpe?g|png|webp)$/i.test(last) ? last : `${m.kind}-${m.sort_order}.${ext}`
}

export async function fetchMedia(d: JobDeps): Promise<number> {
  const now = nowMs(d)
  await d.listings.resetStuckMedia(iso(now))
  const rows = await d.listings.claimDueMedia(iso(now), MEDIA_LIMITS.perTick)
  for (const m of rows) {
    const outcome = await fetchOne(d, m).catch(e => {
      d.log?.error({ media: m.id, err: String(e?.message ?? e) }, 'partner media fetch crashed')
      return 'retry' as const
    })
    if (outcome === 'retry') await retryLater(d, m, 'FETCH_FAILED', 'Could not fetch the file; retrying')
    if (outcome !== 'deferred') await d.service.reevaluate(m.tour_ref_id).catch(() => {})
  }
  return rows.length
}

async function retryLater(d: JobDeps, m: MediaRow, code: string, message: string) {
  const attempts = m.attempts + 1
  if (attempts >= MEDIA_LIMITS.retryDelaysS.length) return failMedia(d, m, code, message.replace(/; retrying$/, ''), attempts)
  await d.listings.updateMedia(m.id, { status: 'pending', attempts, error_code: code, error_message: message, next_attempt_at: iso(nowMs(d) + MEDIA_LIMITS.retryDelaysS[attempts - 1] * 1000), locked_until: null } as any)
}

async function failMedia(d: JobDeps, m: MediaRow, code: string, message: string, attempts = m.attempts + 1) {
  await d.listings.updateMedia(m.id, { status: 'failed', attempts, error_code: code, error_message: message.slice(0, 300), locked_until: null } as any)
  const ref = await d.partners.getTourRef(m.partner_id, m.mode, { id: m.tour_ref_id })
  await d.listings.insertEvents(m.partner_id, m.mode, [{ event_type: 'media.failed', payload: {
    media: { id: m.id, kind: m.kind, source_url: m.source_url, error: { code, message } },
    listing: ref ? { id: `lst_${ref.id}`, external_id: ref.external_id } : null,
  } }])
}

async function fetchOne(d: JobDeps, m: MediaRow): Promise<'done' | 'retry' | 'deferred'> {
  const kind = FETCHED_KINDS[m.kind]
  if (!kind) { await d.listings.updateMedia(m.id, { status: 'skipped', error_code: 'KIND_NOT_PROCESSED' } as any); return 'done' }
  const [partner, ref] = await Promise.all([d.partners.getPartner(m.partner_id), d.partners.getTourRef(m.partner_id, m.mode, { id: m.tour_ref_id })])
  const agent = ref ? (await d.partners.getAgentsByIds([ref.agent_id]))[0] : undefined
  if (!partner || !ref || !agent) { await d.listings.updateMedia(m.id, { status: 'removed' } as any); return 'done' }

  // The same daily cap as direct uploads; over it, wait for tomorrow (not a failure).
  if (d.redis) {
    const dayKey = `partner:uploads:${partner.id}:${todayEAT(nowMs(d))}`
    try {
      const n = Number(await d.redis.incr(dayKey))
      if (n === 1) void Promise.resolve(d.redis.expire(dayKey, 2 * 86400)).catch(() => {})
      if (n > partner.daily_upload_cap) {
        await d.listings.updateMedia(m.id, { status: 'pending', error_code: 'DAILY_UPLOAD_CAP', error_message: 'Daily upload limit reached; continues after midnight EAT', next_attempt_at: iso(nextMidnightEAT(nowMs(d))), locked_until: null } as any)
        return 'deferred'
      }
    } catch { /* counting is best effort */ }
  }

  let res
  try {
    res = await d.fetch(m.source_url, { timeoutMs: MEDIA_LIMITS.timeoutMs, maxBytes: MEDIA_LIMITS.maxBytes[kind] ?? MEDIA_LIMITS.maxBytes.default, headers: { accept: 'image/*' } })
  } catch (e: any) {
    if (e instanceof SafeFetchError && ['URL_NOT_HTTPS', 'URL_PRIVATE_NETWORK', 'TOO_LARGE', 'BAD_URL'].includes(e.code)) {
      await failMedia(d, m, e.code === 'TOO_LARGE' ? 'FILE_TOO_LARGE' : e.code, e.message)
      return 'done'
    }
    await retryLater(d, m, 'FETCH_FAILED', `${e?.message ?? 'Could not fetch the file'}; retrying`)
    return 'done'
  }
  if (res.status >= 300 && res.status < 400) { await failMedia(d, m, 'REDIRECT_NOT_FOLLOWED', 'The URL redirects; send the final file URL'); return 'done' }
  if (res.status === 408 || res.status === 429 || res.status >= 500) { await retryLater(d, m, 'SOURCE_UNAVAILABLE', `Your server answered ${res.status}; retrying`); return 'done' }
  if (res.status !== 200) { await failMedia(d, m, 'SOURCE_NOT_FOUND', `Your server answered ${res.status}`); return 'done' }
  const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (!MEDIA_LIMITS.types.includes(type)) { await failMedia(d, m, 'UNSUPPORTED_TYPE', `Expected a JPEG, PNG or WebP image, got ${type || 'no content type'}`); return 'done' }
  if (!res.body.length) { await failMedia(d, m, 'EMPTY_FILE', 'The file is empty'); return 'done' }

  const sha = createHash('sha256').update(res.body).digest('hex')
  if (await d.listings.findMediaBySha(m.tour_ref_id, sha)) {
    await d.listings.updateMedia(m.id, { status: 'skipped', sha256: sha, error_code: 'DUPLICATE_FILE', error_message: 'The same file is already on this listing', locked_until: null } as any)
    return 'done'
  }
  const up = await d.tours.uploadFile(agent.user_id, ref.space_id, { kind, bytes: res.body, contentType: type, fileName: fileNameFor(m, type), angle: m.angle, caption: m.caption })
  if (!up.ok) {
    if (up.status >= 500 || up.status === 429) await retryLater(d, m, up.code, `${up.message}; retrying`)
    else await failMedia(d, m, up.code, up.message)
    return 'done'
  }
  await d.listings.updateMedia(m.id, { status: 'ready', sha256: sha, bytes: res.body.length, space_media_id: up.mediaId, vehicle_view_id: up.viewId, error_code: null, error_message: null, locked_until: null } as any)
  return 'done'
}

// ── bulk imports ────────────────────────────────────────────────────────────

export const IMPORT_CHUNK = 50

export async function runImports(d: JobDeps): Promise<number> {
  const now = nowMs(d)
  const imp = await d.listings.claimImport(iso(now))
  if (!imp) return 0
  const partner = await d.partners.getPartner(imp.partner_id)
  if (!partner) { await d.listings.updateImport(imp.id, { status: 'failed', finished_at: iso(now), items: null, locked_until: null }); return 1 }
  if (imp.status === 'queued') await d.listings.updateImport(imp.id, { status: 'running', started_at: iso(now) })

  const ctx: Ctx = { partner, mode: imp.mode, actor: { type: 'partner_key', id: imp.key_id, requestId: `imp_${imp.id}` } }
  const items = imp.items ?? []
  const counts = { ...imp.counts }
  const errors = [...imp.errors]
  const end = Math.min(items.length, imp.cursor + IMPORT_CHUNK)
  for (let i = imp.cursor; i < end; i++) {
    const item = items[i] as any
    const ext = typeof item?.external_id === 'string' ? item.external_id : null
    try {
      const r = imp.dry_run ? await d.service.check(ctx, item) : await d.service.upsert(ctx, item, imp.id)
      if (r.outcome === 'failed') {
        counts.failed++
        const e = r.result.body?.error ?? {}
        errors.push({ index: i, external_id: ext, code: e.code ?? 'FAILED', ...(e.fields?.[0] ? { field: e.fields[0].field ?? String(e.fields[0]) } : {}), message: e.fields?.[0]?.message ?? e.message ?? 'Failed' })
      } else counts[r.outcome]++
    } catch (err: any) {
      counts.failed++
      errors.push({ index: i, external_id: ext, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side with this item. Send it again.' })
      d.log?.error({ import: imp.id, index: i, err: String(err?.message ?? err) }, 'partner import item crashed')
    }
  }
  const done = end >= items.length
  await d.listings.updateImport(imp.id, {
    cursor: end, counts, errors, locked_until: null,
    ...(done ? { status: 'completed', finished_at: iso(nowMs(d)), items: null } : {}),
  })
  if (done) {
    await d.listings.insertEvents(imp.partner_id, imp.mode, [{ event_type: 'import.completed', payload: {
      import: { id: `imp_${imp.id}`, dry_run: imp.dry_run, counts: { received: imp.total, ...counts }, errors: errors.length },
    } }])
  }
  return 1
}

// ── sweeps ──────────────────────────────────────────────────────────────────

export async function runSweeps(d: JobDeps): Promise<void> {
  const now = nowMs(d)
  for (const s of await d.listings.dueExpiries(iso(now), 50)) await d.service.expire(s).catch(e => d.log?.warn({ err: String(e) }, 'partner expiry failed'))
  // Listings waiting for photos to finish processing on the tour.
  for (const s of await d.listings.statesByStatus('submitted', iso(now - 2 * 60_000), 20)) await d.service.reevaluate(s.tour_ref_id).catch(() => {})
  await d.listings.purgeIdem(iso(now))
}

/** One pass of everything. Each part is independent: one failing does not stop the others. */
export async function tick(d: JobDeps, opts: { sweeps?: boolean } = {}) {
  const parts: [string, () => Promise<unknown>][] = [
    ['dispatch', () => dispatchEvents(d)],
    ['deliver', () => deliverWebhooks(d)],
    ['media', () => fetchMedia(d)],
    ['imports', () => runImports(d)],
  ]
  if (opts.sweeps) parts.push(['sweeps', () => runSweeps(d)])
  for (const [name, run] of parts) {
    try { await run() } catch (e: any) { d.log?.error({ job: name, err: String(e?.message ?? e) }, 'partner job failed') }
  }
}

/** Runs tick() every few seconds (sweeps once a minute). Returns a stop function. */
export function startPartnerJobs(d: JobDeps, intervalMs = 5000): () => void {
  let running = false
  let n = 0
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try { await tick(d, { sweeps: n++ % Math.max(1, Math.round(60_000 / intervalMs)) === 0 }) } finally { running = false }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
