import { randomUUID } from 'node:crypto'
import type { KeyMode } from '../utils/partnerKeys.js'
import type { MediaCounts } from './listingModel.js'
import type {
  AgentLite, AnalyticsRow, AuditInput, ClaimRow, DeliveryRow, EventInput, ExportSpace, IdemRow, ImportRow, LeadRow, ListingStore,
  MediaRow, OutboxRow, StateRow, TextRow, WebhookRow,
} from './listingStore.js'
import type { TourRefRow } from './store.js'

// An in-memory ListingStore with the same rules as the database
// (api_listing_commit's version check, unique keys, tenant columns).
// Used by the tests and handy for local experiments.

export type MemoryWorld = {
  refs: () => TourRefRow[]
  partnerNames?: Record<string, string>
  mediaCounts?: (spaceId: string) => MediaCounts
  /** consent: null = the buyer did not agree to share (never returned). */
  leads?: (Omit<LeadRow, 'consent'> & { partner_id: string; mode: KeyMode; consent: LeadRow['consent'] | null })[]
  agents?: () => (AgentLite & { partner_name?: string })[]
  analytics?: (AnalyticsRow & { partner_id: string; mode: KeyMode })[]
  spaces?: ExportSpace[]
}

export type AuditRow = AuditInput & { partner_id: string | null; mode: KeyMode | null; entity_type: string; entity_id: string | null; occurred_at: string }

export function memoryListingStore(world: MemoryWorld, clock: () => number = Date.now) {
  const states = new Map<string, StateRow>()
  const audit: AuditRow[] = []
  const outbox: OutboxRow[] = []
  const media: (MediaRow & { locked_until?: string | null; bytes?: number; updated_at?: string })[] = []
  const idem = new Map<string, IdemRow>()
  const webhooks: WebhookRow[] = []
  const deliveries: (DeliveryRow & { locked_until?: string | null })[] = []
  const imports: (ImportRow & { locked_until?: string | null })[] = []
  const claims: ClaimRow[] = []
  const texts: TextRow[] = [
    { id: randomUUID(), key: 'lead_share_consent', locale: 'en', version: 1, subject: null, body: 'Share my details with {partner}.', active: true, created_by: 'seed', created_at: new Date(0).toISOString() },
    { id: randomUUID(), key: 'webhook_disabled_email', locale: 'en', version: 1, subject: 'Webhook switched off', body: 'Hello {partner}, {url} was switched off. Enable: {webhook_id}', active: true, created_by: 'seed', created_at: new Date(0).toISOString() },
  ]
  const consents: (Parameters<ListingStore['insertConsent']>[0] & { withdrawn_at: string | null })[] = []
  let seq = 0
  const iso = () => new Date(clock()).toISOString()
  const refOf = (id: string) => world.refs().find(r => r.id === id)
  const clone = <T>(v: T): T => structuredClone(v)

  const STATE_DEFAULTS = {
    availability: 'available', publication_status: 'draft', moderation_reasons: [], listing: {}, pending_listing: null,
    vin_hash: null, chassis_hash: null, partner_updated_at: null, published_at: null, expires_at: null, archived_at: null,
    restore_until: null, reviewed_at: null, reviewed_by: null, last_import_id: null, change_origin: 'api',
  }

  const store: ListingStore & {
    _states: typeof states; _audit: typeof audit; _outbox: typeof outbox; _media: typeof media
    _webhooks: typeof webhooks; _deliveries: typeof deliveries; _imports: typeof imports
    _claims: typeof claims; _texts: typeof texts; _consents: typeof consents
  } = {
    _states: states, _audit: audit, _outbox: outbox, _media: media, _webhooks: webhooks, _deliveries: deliveries, _imports: imports,
    _claims: claims, _texts: texts, _consents: consents,

    async getState(id) { const s = states.get(id); return s ? clone(s) : null },
    async getStates(ids) { return ids.flatMap(id => states.has(id) ? [clone(states.get(id)!)] : []) },

    async listStates(f) {
      const desc = f.sort.startsWith('-')
      const col = f.sort.replace('-', '') as 'updated_at' | 'created_at'
      let rows = [...states.values()].filter(s => s.partner_id === f.partnerId && s.mode === f.mode)
        .map(s => ({ ...clone(s), ref: refOf(s.tour_ref_id)! })).filter(s => s.ref)
      if (f.availability) rows = rows.filter(s => s.availability === f.availability)
      if (f.publicationStatus) rows = rows.filter(s => s.publication_status === f.publicationStatus)
      if (f.updatedSince) rows = rows.filter(s => s.updated_at >= f.updatedSince!)
      if (f.externalId) rows = rows.filter(s => s.ref.external_id === f.externalId)
      if (f.agentId) rows = rows.filter(s => s.ref.agent_id === f.agentId)
      const key = (s: StateRow) => `${s[col]}|${s.tour_ref_id}`
      rows.sort((a, b) => (key(a) < key(b) ? -1 : 1) * (desc ? -1 : 1))
      if (f.after) {
        const k = `${f.after.t}|${f.after.id}`
        rows = rows.filter(s => desc ? key(s) < k : key(s) > k)
      }
      return rows.slice(0, f.limit)
    },

    async listActiveVersions(pid, mode) {
      return [...states.values()].filter(s => s.partner_id === pid && s.mode === mode && s.publication_status !== 'archived')
        .map(s => ({ tour_ref_id: s.tour_ref_id, external_id: refOf(s.tour_ref_id)!.external_id, version: s.version }))
    },

    async commit(id, expected, state, a, events) {
      const ref = refOf(id)
      if (!ref) return { ok: false, reason: 'not_found' }
      const cur = states.get(id)
      if (expected === null && cur) return { ok: false, reason: 'exists' }
      if (expected !== null && !cur) return { ok: false, reason: 'not_found' }
      if (expected !== null && cur!.version !== expected) return { ok: false, reason: 'conflict' }
      const { tour_ref_id, partner_id, mode, version, created_at, ...rest } = state as any
      const t = iso()
      const next: StateRow = {
        ...(cur ?? (STATE_DEFAULTS as any)), ...clone(rest),
        tour_ref_id: id, partner_id: ref.partner_id, mode: ref.mode,
        version: cur ? cur.version + 1 : 1, created_at: cur?.created_at ?? t, updated_at: t,
      }
      // The table's own checks that matter to the rules.
      if (next.publication_status === 'archived' && !next.archived_at) throw new Error('api_listing_state_archive')
      states.set(id, next)
      if (a) audit.push({ ...clone(a), partner_id: ref.partner_id, mode: ref.mode, entity_type: 'listing', entity_id: id, occurred_at: t })
      for (const e of events) outbox.push({ id: randomUUID(), seq: ++seq, partner_id: ref.partner_id, mode: ref.mode, event_type: e.event_type, payload: clone(e.payload), created_at: t, dispatched_at: null })
      return { ok: true, version: next.version, created_at: next.created_at, updated_at: next.updated_at }
    },

    async touchExpiry(id, expiresAt) { const s = states.get(id); if (s) s.expires_at = expiresAt },

    async countPriceChanges(id, since) {
      return audit.filter(a => a.entity_id === id && a.action === 'listing.price_changed' && a.occurred_at >= since).length
    },
    async countApproved(pid, mode) {
      return [...states.values()].filter(s => s.partner_id === pid && s.mode === mode && (s.reviewed_at || s.published_at)).length
    },
    async countActive(pid, mode) {
      return [...states.values()].filter(s => s.partner_id === pid && s.mode === mode && s.publication_status !== 'archived').length
    },
    async countRecentArchives(pid, mode, since) {
      return audit.filter(a => a.partner_id === pid && a.mode === mode && a.action === 'listing.archived' && a.occurred_at >= since).length
    },
    async findVehicleMatches(id, vin, chassis) {
      return [...states.values()].filter(s => s.tour_ref_id !== id && s.publication_status !== 'archived' &&
        ((vin && s.vin_hash === vin) || (chassis && s.chassis_hash === chassis))).map(s => s.tour_ref_id)
    },
    async dueExpiries(now, limit) {
      return [...states.values()].filter(s => s.publication_status === 'published' && s.expires_at && s.expires_at < now).slice(0, limit).map(clone)
    },
    async statesByStatus(status, before, limit) {
      return [...states.values()].filter(s => s.publication_status === status && s.updated_at < before).slice(0, limit).map(clone)
    },
    async moderationQueue(limit) {
      return [...states.values()].filter(s => s.publication_status === 'pending_moderation').slice(0, limit)
        .map(s => ({ ...clone(s), ref: refOf(s.tour_ref_id)!, partner_name: world.partnerNames?.[s.partner_id] ?? '' }))
    },
    async mediaCounts(spaceId) {
      return world.mediaCounts?.(spaceId) ?? { photo: 0, panorama: 0, tour: 0, car_exterior: 0 }
    },

    async idemGet(pid, mode, key) { const r = idem.get(`${pid}|${mode}|${key}`); return r ? clone(r) : null },
    async idemInsert(pid, mode, key, row) {
      const k = `${pid}|${mode}|${key}`
      if (idem.has(k)) return 'exists'
      idem.set(k, { ...row, status_code: null, response: null, expires_at: new Date(clock() + 86400_000).toISOString() })
      return 'ok'
    },
    async idemFinish(pid, mode, key, status, response) {
      const r = idem.get(`${pid}|${mode}|${key}`)
      if (r) { r.status_code = status; r.response = clone(response) }
    },
    async idemDelete(pid, mode, key) { idem.delete(`${pid}|${mode}|${key}`) },
    async purgeIdem(now) { for (const [k, v] of idem) if (v.expires_at < now) idem.delete(k) },

    async listMedia(id) { return media.filter(m => m.tour_ref_id === id).sort((a, b) => a.sort_order - b.sort_order).map(clone) },
    async listMediaFor(ids) { return media.filter(m => ids.includes(m.tour_ref_id)).map(clone) },
    async insertMedia(rows) {
      for (const r of rows) {
        if (media.some(m => m.tour_ref_id === r.tour_ref_id && m.source_url === r.source_url)) continue
        media.push({
          id: randomUUID(), status: 'pending', error_code: null, error_message: null, attempts: 0, next_attempt_at: iso(),
          sha256: null, space_media_id: null, vehicle_view_id: null, created_at: iso(), ...clone(r),
        } as MediaRow)
      }
    },
    async updateMedia(id, patch) { const m = media.find(x => x.id === id); if (m) Object.assign(m, clone(patch), { updated_at: iso() }) },
    async claimDueMedia(now, limit) {
      const due = media.filter(m => m.status === 'pending' && m.next_attempt_at <= now).slice(0, limit)
      for (const m of due) { m.status = 'fetching'; m.locked_until = new Date(Date.parse(now) + 300_000).toISOString() }
      return due.map(clone)
    },
    async resetStuckMedia(now) { for (const m of media) if (m.status === 'fetching' && m.locked_until && m.locked_until < now) m.status = 'pending' },
    async failedMedia(limit) { return media.filter(m => m.status === 'failed').slice(0, limit).map(clone) },
    async findMediaBySha(id, sha) { const m = media.find(x => x.tour_ref_id === id && x.sha256 === sha && x.status === 'ready'); return m ? clone(m) : null },

    async insertEvents(pid, mode, events: EventInput[]) {
      for (const e of events) outbox.push({ id: randomUUID(), seq: ++seq, partner_id: pid, mode, event_type: e.event_type, payload: clone(e.payload), created_at: iso(), dispatched_at: null })
    },
    async undispatched(limit) { return outbox.filter(e => !e.dispatched_at).slice(0, limit).map(clone) },
    async markDispatched(ids) { for (const e of outbox) if (ids.includes(e.id)) e.dispatched_at = iso() },
    async getEvent(id) { const e = outbox.find(x => x.id === id); return e ? clone(e) : null },

    async listWebhooks(pid, mode) { return webhooks.filter(w => w.partner_id === pid && w.mode === mode && !w.deleted_at).map(clone) },
    async getWebhook(id) { const w = webhooks.find(x => x.id === id); return w ? clone(w) : null },
    async insertWebhook(row) {
      const w: WebhookRow = { id: randomUUID(), status: 'active', disabled_reason: null, failing_since: null, created_at: iso(), deleted_at: null, ...clone(row) }
      webhooks.push(w)
      return clone(w)
    },
    async updateWebhook(id, patch) { const w = webhooks.find(x => x.id === id); if (w) Object.assign(w, clone(patch)) },

    async insertDeliveries(rows) {
      for (const r of rows) {
        if (deliveries.some(d => d.webhook_id === r.webhook_id && d.event_id === r.event_id)) continue
        deliveries.push({ id: randomUUID(), status: 'pending', attempts: 0, next_attempt_at: iso(), last_status: null, last_error: null, created_at: iso(), delivered_at: null, ...r })
      }
    },
    async claimDueDeliveries(now, limit) {
      const due = deliveries.filter(d => d.status === 'pending' && d.next_attempt_at <= now && (!d.locked_until || d.locked_until < now)).slice(0, limit)
      for (const d of due) d.locked_until = new Date(Date.parse(now) + 120_000).toISOString()
      return due.map(clone)
    },
    async updateDelivery(id, patch) { const d = deliveries.find(x => x.id === id); if (d) Object.assign(d, clone(patch)) },
    async deliveries({ webhookId, status, limit }) {
      return deliveries.filter(d => (!webhookId || d.webhook_id === webhookId) && (!status || d.status === status)).slice(-limit).reverse().map(clone)
    },

    async insertImport(row) {
      const r: ImportRow & { locked_until?: string | null } = {
        id: randomUUID(), status: 'queued', cursor: 0, counts: { created: 0, updated: 0, unchanged: 0, failed: 0 }, errors: [],
        created_at: iso(), started_at: null, finished_at: null, locked_until: null, ...clone(row),
      }
      imports.push(r)
      return clone(r)
    },
    async getImport(id, pid, mode) { const r = imports.find(i => i.id === id && i.partner_id === pid && i.mode === mode); return r ? clone(r) : null },
    async countOpenImports(pid, mode) { return imports.filter(i => i.partner_id === pid && i.mode === mode && ['queued', 'running'].includes(i.status)).length },
    async claimImport(now) {
      const seen = new Set<string>()
      for (const i of imports.filter(x => ['queued', 'running'].includes(x.status))) {
        if (seen.has(i.partner_id)) continue
        seen.add(i.partner_id)
        if (i.locked_until && i.locked_until > now) continue
        i.locked_until = new Date(Date.parse(now) + 120_000).toISOString()
        return clone(i)
      }
      return null
    },
    async updateImport(id, patch) { const i = imports.find(x => x.id === id); if (i) Object.assign(i, clone(patch)) },
    async failedImports(limit) { return imports.filter(i => i.status === 'failed').slice(0, limit).map(clone) },

    async insertAudit(row) { audit.push({ ...clone(row), occurred_at: iso() }) },

    async leads(pid, mode, q) {
      let rows = (world.leads ?? []).filter(l => l.partner_id === pid && l.mode === mode)
      if (q.spaceId) rows = rows.filter(l => l.space_id === q.spaceId)
      if (q.since) rows = rows.filter(l => l.created_at >= q.since!)
      rows = rows.sort((a, b) => (`${b.created_at}|${b.id}` < `${a.created_at}|${a.id}` ? -1 : 1))
      if (q.after) rows = rows.filter(l => `${l.created_at}|${l.id}` < `${q.after!.t}|${q.after!.id}`)
      return rows.filter(l => l.consent).slice(0, q.limit).map(({ partner_id, mode, ...l }) => clone(l) as LeadRow)
    },
    async analytics(pid, mode, q) {
      return (world.analytics ?? []).filter(r => r.partner_id === pid && r.mode === mode && r.date >= q.from && r.date <= q.to && (!q.spaceId || r.space_id === q.spaceId))
        .map(({ partner_id, mode, ...r }) => clone(r))
    },
    async exportSpaces(pid, mode, q) {
      const userIds = (world.agents?.() ?? []).filter(a => a.partner_id === pid && a.mode === mode).map(a => a.user_id)
      let rows = (world.spaces ?? []).filter(s => userIds.includes(s.user_id) && s.is_published)
        .sort((a, b) => (`${b.updated_at}|${b.id}` < `${a.updated_at}|${a.id}` ? -1 : 1))
      if (q.after) rows = rows.filter(s => `${s.updated_at}|${s.id}` < `${q.after!.t}|${q.after!.id}`)
      return rows.slice(0, q.limit).map(clone)
    },
    async duePurges(now, limit) {
      return [...states.values()].filter(s => s.publication_status === 'archived' && s.restore_until && s.restore_until < now).slice(0, limit).map(clone)
    },
    async agentsByUsers(pid, mode, userIds) {
      return (world.agents?.() ?? []).filter(a => a.partner_id === pid && a.mode === mode && userIds.includes(a.user_id)).map(clone)
    },
    async agentsForUser(userId) {
      return (world.agents?.() ?? []).filter(a => a.user_id === userId).map(a => ({ ...clone(a), partner_name: a.partner_name ?? world.partnerNames?.[a.partner_id] ?? 'A partner' }))
    },
    async insertClaim(row) {
      const open = claims.filter(c => c.status === 'pending')
      if (open.some(c => c.space_id === row.space_id || (c.partner_id === row.partner_id && c.mode === row.mode && c.external_id === row.external_id))) return 'duplicate'
      const c: ClaimRow = { id: randomUUID(), status: 'pending', created_at: iso(), expires_at: new Date(clock() + 14 * 86400_000).toISOString(), decided_at: null, decided_by: null, ...clone(row) }
      claims.push(c)
      return clone(c)
    },
    async getClaim(id) { const c = claims.find(x => x.id === id); return c ? clone(c) : null },
    async listClaims(f) {
      return claims.filter(c => (!f.partnerId || c.partner_id === f.partnerId) && (!f.mode || c.mode === f.mode)
        && (!f.agentIds || f.agentIds.includes(c.agent_id)) && (!f.status || c.status === f.status)).slice(-f.limit).reverse().map(clone)
    },
    async decideClaim(id, status, by, now) {
      const c = claims.find(x => x.id === id && x.status === 'pending')
      if (!c) return null
      Object.assign(c, { status, decided_by: by, decided_at: now })
      return clone(c)
    },
    async dueClaimExpiries(now, limit) { return claims.filter(c => c.status === 'pending' && c.expires_at < now).slice(0, limit).map(clone) },
    async activeText(key, locale) { const t = texts.find(x => x.key === key && x.locale === locale && x.active); return t ? clone(t) : null },
    async listTexts() { return texts.map(clone) },
    async saveText(row) {
      const same = texts.filter(t => t.key === row.key && t.locale === row.locale)
      for (const t of same) t.active = false
      const t: TextRow = { id: randomUUID(), version: Math.max(0, ...same.map(x => x.version)) + 1, active: true, created_at: iso(), ...clone(row) }
      texts.push(t)
      return clone(t)
    },
    async insertConsent(row) {
      if (consents.some(c => c.lead_id === row.lead_id)) throw new Error('consent: duplicate key')
      consents.push({ ...clone(row), withdrawn_at: null })
    },
    async withdrawConsent(leadId, now) {
      const c = consents.find(x => x.lead_id === leadId && !x.withdrawn_at)
      if (c) c.withdrawn_at = now
      return Boolean(c)
    },
  }
  return store
}
