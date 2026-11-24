import type { FastifyInstance } from 'fastify'
import type { KeyMode } from '../utils/partnerKeys.js'
import type { TourRefRow } from './store.js'
import type { Availability, ListingInput, MediaCounts, PublicationStatus, Transaction, Vertical } from './listingModel.js'

// Every read and write of the listing tables (migrations 003 to 005),
// behind one interface. Tenant scoping lives here: every partner-facing
// method takes partnerId and mode. Routes never touch these tables directly.

export type Reason = { code: string; field?: string; message: string; by?: 'system' | 'moderator' }

/** The partner's listing as stored: no raw VIN or chassis number, only their last 4 characters. */
export type StoredListing = ListingInput & { _ids?: { vin_last4?: string; chassis_last4?: string } }

export type StateRow = {
  tour_ref_id: string
  partner_id: string
  mode: KeyMode
  vertical: Vertical
  transaction: Transaction
  version: number
  availability: Availability
  publication_status: PublicationStatus
  moderation_reasons: Reason[]
  listing: StoredListing
  pending_listing: StoredListing | null
  vin_hash: string | null
  chassis_hash: string | null
  partner_updated_at: string | null
  published_at: string | null
  expires_at: string | null
  archived_at: string | null
  restore_until: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  last_import_id: string | null
  change_origin: 'api' | 'app' | 'admin' | 'system'
  created_at: string
  updated_at: string
}

export type ListedState = StateRow & { ref: TourRefRow }

export type AuditInput = { actor_type: 'partner_key' | 'user' | 'staff' | 'system'; actor_id: string | null; action: string; changes: Record<string, unknown>; request_id?: string | null }
export type EventInput = { event_type: string; payload: Record<string, unknown> }
export type CommitResult = { ok: true; version: number; created_at: string; updated_at: string } | { ok: false; reason: 'conflict' | 'exists' | 'not_found' }

export type ListSort = 'updated_at' | '-updated_at' | 'created_at' | '-created_at'
export type ListFilter = {
  partnerId: string
  mode: KeyMode
  availability?: Availability
  publicationStatus?: PublicationStatus
  updatedSince?: string
  externalId?: string
  agentId?: string
  sort: ListSort
  /** Keyset cursor: the sort value and tour_ref_id of the last row already returned. */
  after?: { t: string; id: string }
  limit: number
}

export type MediaStatus = 'pending' | 'fetching' | 'ready' | 'failed' | 'skipped' | 'removed'
export type MediaRow = {
  id: string
  tour_ref_id: string
  partner_id: string
  mode: KeyMode
  kind: string
  source_url: string
  sort_order: number
  caption: string | null
  angle: number | null
  status: MediaStatus
  error_code: string | null
  error_message: string | null
  attempts: number
  next_attempt_at: string
  sha256: string | null
  space_media_id: string | null
  vehicle_view_id: string | null
  created_at: string
}
export type NewMedia = Pick<MediaRow, 'tour_ref_id' | 'partner_id' | 'mode' | 'kind' | 'source_url' | 'sort_order' | 'caption' | 'angle'> & { status?: MediaStatus; error_code?: string | null; error_message?: string | null }

export type OutboxRow = { id: string; seq: number; partner_id: string; mode: KeyMode; event_type: string; payload: Record<string, any>; created_at: string; dispatched_at: string | null }

export type WebhookRow = {
  id: string; partner_id: string; mode: KeyMode; url: string; events: string[]
  secret_cipher: string; secret_prefix: string; status: 'active' | 'disabled'; disabled_reason: string | null
  failing_since: string | null; created_at: string; deleted_at: string | null
  /** Migration 005: the secret before the last rotation, still signing until it expires. */
  prev_secret_cipher?: string | null; prev_secret_expires_at?: string | null
}

export type DeliveryStatus = 'pending' | 'succeeded' | 'dead' | 'discarded'
export type DeliveryRow = {
  id: string; webhook_id: string; event_id: string; partner_id: string; status: DeliveryStatus; attempts: number
  next_attempt_at: string; last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null
}

export type ImportCounts = { created: number; updated: number; unchanged: number; failed: number }
export type ImportError = { index: number; external_id: string | null; code: string; field?: string; message: string }
export type ImportRow = {
  id: string; partner_id: string; mode: KeyMode; key_id: string | null
  status: 'queued' | 'running' | 'completed' | 'failed'; dry_run: boolean
  items: unknown[] | null; total: number; cursor: number; counts: ImportCounts; errors: ImportError[]
  created_at: string; started_at: string | null; finished_at: string | null
}

export type IdemRow = { method: string; path: string; request_hash: string; status_code: number | null; response: unknown; expires_at: string }

export type LeadRow = {
  id: string; space_id: string; ref: Pick<TourRefRow, 'id' | 'external_id'>
  name: string | null; email: string | null; phone: string | null; message: string | null; source: string | null; created_at: string
  /** The buyer agreed, in these words, to share their details with the partner. */
  consent: { wording: string; given_at: string }
}

export type ClaimStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired'
export type ClaimRow = {
  id: string; partner_id: string; mode: KeyMode; agent_id: string; space_id: string; external_id: string; note: string | null
  status: ClaimStatus; created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null
}
export type TextRow = {
  id: string; key: string; locale: string; version: number; subject: string | null; body: string; active: boolean
  created_by: string | null; created_at: string
}
export type ConsentInput = { lead_id: string; partner_id: string; mode: KeyMode; text_id: string | null; wording: string; locale: string; accepted: boolean }
export type AgentLite = { id: string; partner_id: string; mode: KeyMode; external_id: string; user_id: string; name: string | null }
export type AnalyticsRow = { space_id: string; ref: Pick<TourRefRow, 'id' | 'external_id'>; date: string; counts: Record<string, number> }
export type ExportSpace = {
  id: string; user_id: string; title: string; slug: string | null; property_type: string; is_published: boolean
  cover_image_url: string | null; price_kes: number | null; listing_status: string | null; transaction_type: string | null
  price_period: string | null; bedrooms: number | null; bathrooms: number | null; location_text: string | null
  created_at: string; updated_at: string
}

export interface ListingStore {
  getState(tourRefId: string): Promise<StateRow | null>
  getStates(tourRefIds: string[]): Promise<StateRow[]>
  listStates(filter: ListFilter): Promise<ListedState[]>
  /** external_id and version of every listing not archived (for reconcile). */
  listActiveVersions(partnerId: string, mode: KeyMode): Promise<{ tour_ref_id: string; external_id: string; version: number }[]>
  /** One transaction: the state row, its audit row and its events (api_listing_commit). */
  commit(tourRefId: string, expectedVersion: number | null, state: Record<string, unknown>, audit: AuditInput | null, events: EventInput[]): Promise<CommitResult>
  /** Pushes expiry out without a new version (an unchanged re-send confirms the listing). */
  touchExpiry(tourRefId: string, expiresAt: string | null): Promise<void>
  countPriceChanges(tourRefId: string, sinceIso: string): Promise<number>
  /** Live listings a moderator has approved or that went live (for the first-listings review rule). */
  countApproved(partnerId: string, mode: KeyMode): Promise<number>
  countActive(partnerId: string, mode: KeyMode): Promise<number>
  countRecentArchives(partnerId: string, mode: KeyMode, sinceIso: string): Promise<number>
  /** Other listings (any partner) with the same VIN or chassis hash, not archived. */
  findVehicleMatches(tourRefId: string, vinHash: string | null, chassisHash: string | null): Promise<string[]>
  dueExpiries(nowIso: string, limit: number): Promise<StateRow[]>
  /** Archived listings whose restore window has passed. */
  duePurges(nowIso: string, limit: number): Promise<StateRow[]>
  /** Listings in a status, last changed before the given time (oldest first). */
  statesByStatus(status: PublicationStatus, changedBeforeIso: string, limit: number): Promise<StateRow[]>
  moderationQueue(limit: number): Promise<(ListedState & { partner_name: string })[]>
  /** Tour media the publish rules count: processed photos and 360s, and car exterior photos. */
  mediaCounts(spaceId: string): Promise<MediaCounts>

  idemGet(partnerId: string, mode: KeyMode, key: string): Promise<IdemRow | null>
  idemInsert(partnerId: string, mode: KeyMode, key: string, row: { method: string; path: string; request_hash: string }): Promise<'ok' | 'exists'>
  idemFinish(partnerId: string, mode: KeyMode, key: string, status: number, response: unknown): Promise<void>
  idemDelete(partnerId: string, mode: KeyMode, key: string): Promise<void>
  purgeIdem(nowIso: string): Promise<void>

  listMedia(tourRefId: string): Promise<MediaRow[]>
  listMediaFor(tourRefIds: string[]): Promise<MediaRow[]>
  /** Rows whose (tour_ref_id, source_url) already exists are left as they are. */
  insertMedia(rows: NewMedia[]): Promise<void>
  updateMedia(id: string, patch: Partial<MediaRow>): Promise<void>
  claimDueMedia(nowIso: string, limit: number): Promise<MediaRow[]>
  resetStuckMedia(nowIso: string): Promise<void>
  failedMedia(limit: number): Promise<MediaRow[]>
  findMediaBySha(tourRefId: string, sha256: string): Promise<MediaRow | null>

  insertEvents(partnerId: string, mode: KeyMode, events: EventInput[]): Promise<void>
  undispatched(limit: number): Promise<OutboxRow[]>
  markDispatched(ids: string[]): Promise<void>
  getEvent(id: string): Promise<OutboxRow | null>

  listWebhooks(partnerId: string, mode: KeyMode): Promise<WebhookRow[]>
  getWebhook(id: string): Promise<WebhookRow | null>
  insertWebhook(row: Pick<WebhookRow, 'partner_id' | 'mode' | 'url' | 'events' | 'secret_cipher' | 'secret_prefix'>): Promise<WebhookRow>
  updateWebhook(id: string, patch: Partial<WebhookRow>): Promise<void>

  insertDeliveries(rows: Pick<DeliveryRow, 'webhook_id' | 'event_id' | 'partner_id'>[]): Promise<void>
  claimDueDeliveries(nowIso: string, limit: number): Promise<DeliveryRow[]>
  updateDelivery(id: string, patch: Partial<DeliveryRow> & { locked_until?: string | null }): Promise<void>
  deliveries(filter: { webhookId?: string; status?: DeliveryStatus; limit: number }): Promise<DeliveryRow[]>

  insertImport(row: Pick<ImportRow, 'partner_id' | 'mode' | 'key_id' | 'dry_run' | 'items' | 'total'>): Promise<ImportRow>
  getImport(id: string, partnerId: string, mode: KeyMode): Promise<ImportRow | null>
  countOpenImports(partnerId: string, mode: KeyMode): Promise<number>
  /** The oldest queued or running import not locked by another worker, locked for 2 minutes. */
  claimImport(nowIso: string): Promise<ImportRow | null>
  updateImport(id: string, patch: Partial<ImportRow> & { locked_until?: string | null }): Promise<void>
  failedImports(limit: number): Promise<ImportRow[]>

  insertAudit(row: AuditInput & { partner_id: string | null; mode: KeyMode | null; entity_type: string; entity_id: string | null }): Promise<void>

  leads(partnerId: string, mode: KeyMode, q: { spaceId?: string; since?: string; after?: { t: string; id: string }; limit: number }): Promise<LeadRow[]>
  analytics(partnerId: string, mode: KeyMode, q: { from: string; to: string; spaceId?: string }): Promise<AnalyticsRow[]>
  /** Published tours owned by the partner's agents in this mode, newest change first (export feed). */
  exportSpaces(partnerId: string, mode: KeyMode, q: { after?: { t: string; id: string }; limit: number }): Promise<ExportSpace[]>
  agentsByUsers(partnerId: string, mode: KeyMode, userIds: string[]): Promise<AgentLite[]>
  /** Every partner agent row for one Viewora account (an account can be an agent of several partners). */
  agentsForUser(userId: string): Promise<(AgentLite & { partner_name: string })[]>

  insertClaim(row: Pick<ClaimRow, 'partner_id' | 'mode' | 'agent_id' | 'space_id' | 'external_id' | 'note'>): Promise<ClaimRow | 'duplicate'>
  getClaim(id: string): Promise<ClaimRow | null>
  listClaims(f: { partnerId?: string; mode?: KeyMode; agentIds?: string[]; status?: ClaimStatus; limit: number }): Promise<ClaimRow[]>
  /** Moves a pending claim to a final status; null when it was no longer pending. */
  decideClaim(id: string, status: Exclude<ClaimStatus, 'pending'>, by: string | null, nowIso: string): Promise<ClaimRow | null>
  dueClaimExpiries(nowIso: string, limit: number): Promise<ClaimRow[]>

  activeText(key: string, locale: string): Promise<TextRow | null>
  listTexts(): Promise<TextRow[]>
  /** Saves a new version and makes it the live one. */
  saveText(row: { key: string; locale: string; subject: string | null; body: string; created_by: string | null }): Promise<TextRow>
  insertConsent(row: ConsentInput): Promise<void>
  withdrawConsent(leadId: string, nowIso: string): Promise<boolean>
}

// ── Supabase implementation ─────────────────────────────────────────────────

const STATE_COLS = 'tour_ref_id, partner_id, mode, vertical, transaction, version, availability, publication_status, moderation_reasons, listing, pending_listing, vin_hash, chassis_hash, partner_updated_at, published_at, expires_at, archived_at, restore_until, reviewed_at, reviewed_by, last_import_id, change_origin, created_at, updated_at'
const REF_COLS = 'id, partner_id, mode, external_id, space_id, agent_id, created_at'
const MEDIA_COLS = 'id, tour_ref_id, partner_id, mode, kind, source_url, sort_order, caption, angle, status, error_code, error_message, attempts, next_attempt_at, sha256, space_media_id, vehicle_view_id, created_at'
const WEBHOOK_COLS = 'id, partner_id, mode, url, events, secret_cipher, secret_prefix, status, disabled_reason, failing_since, created_at, deleted_at, prev_secret_cipher, prev_secret_expires_at'
const CLAIM_COLS = 'id, partner_id, mode, agent_id, space_id, external_id, note, status, created_at, expires_at, decided_at, decided_by'
const TEXT_COLS = 'id, key, locale, version, subject, body, active, created_by, created_at'
const AGENT_COLS = 'id, partner_id, mode, external_id, user_id, name'
const DELIVERY_COLS = 'id, webhook_id, event_id, partner_id, status, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at'
const IMPORT_COLS = 'id, partner_id, mode, key_id, status, dry_run, items, total, cursor, counts, errors, created_at, started_at, finished_at'
const EXPORT_COLS = 'id, user_id, title, slug, property_type, is_published, cover_image_url, price_kes, listing_status, transaction_type, price_period, bedrooms, bathrooms, location_text, created_at, updated_at'

const minutesFrom = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString()

function must<T>(r: { data: T | null; error: any }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data as T
}

/** Keyset condition for "after this row" in the given direction, for PostgREST .or(). */
function afterCondition(col: string, after: { t: string; id: string }, idCol: string, desc: boolean) {
  const op = desc ? 'lt' : 'gt'
  return `${col}.${op}.${after.t},and(${col}.eq.${after.t},${idCol}.${op}.${after.id})`
}

export function supabaseListingStore(fastify: FastifyInstance): ListingStore {
  const db = fastify.supabase

  const count = async (q: any, what: string) => {
    const { count: n, error } = await q
    if (error) throw new Error(`${what}: ${error.message}`)
    return n ?? 0
  }

  return {
    async getState(id) {
      const r = await db.from('api_listing_state').select(STATE_COLS).eq('tour_ref_id', id).maybeSingle()
      return (must(r, 'listing state') as StateRow) ?? null
    },

    async getStates(ids) {
      if (!ids.length) return []
      return must(await db.from('api_listing_state').select(STATE_COLS).in('tour_ref_id', ids), 'listing states') as StateRow[]
    },

    async listStates(f) {
      const desc = f.sort.startsWith('-')
      const col = f.sort.replace('-', '')
      let q = db.from('api_listing_state')
        .select(`${STATE_COLS}, ref:api_partner_tours!inner(${REF_COLS})`)
        .eq('partner_id', f.partnerId).eq('mode', f.mode)
      if (f.availability) q = q.eq('availability', f.availability)
      if (f.publicationStatus) q = q.eq('publication_status', f.publicationStatus)
      if (f.updatedSince) q = q.gte('updated_at', f.updatedSince)
      if (f.externalId) q = q.eq('ref.external_id', f.externalId)
      if (f.agentId) q = q.eq('ref.agent_id', f.agentId)
      if (f.after) q = q.or(afterCondition(col, f.after, 'tour_ref_id', desc))
      q = q.order(col, { ascending: !desc }).order('tour_ref_id', { ascending: !desc }).limit(f.limit)
      return must(await q, 'list listings') as unknown as ListedState[]
    },

    async listActiveVersions(partnerId, mode) {
      const out: { tour_ref_id: string; external_id: string; version: number }[] = []
      for (let from = 0; ; from += 1000) {
        const rows = must(await db.from('api_listing_state')
          .select('tour_ref_id, version, ref:api_partner_tours!inner(external_id)')
          .eq('partner_id', partnerId).eq('mode', mode).neq('publication_status', 'archived')
          .order('tour_ref_id').range(from, from + 999), 'active listings') as any[]
        for (const r of rows) out.push({ tour_ref_id: r.tour_ref_id, external_id: r.ref.external_id, version: r.version })
        if (rows.length < 1000) return out
      }
    },

    async commit(tourRefId, expectedVersion, state, audit, events) {
      const { data, error } = await db.rpc('api_listing_commit', {
        p_tour_ref_id: tourRefId, p_expected_version: expectedVersion, p_state: state, p_audit: audit, p_events: events,
      })
      if (error) {
        if (error.code === 'VO409') return { ok: false, reason: 'conflict' }
        if (error.code === 'VO404') return { ok: false, reason: 'not_found' }
        if (error.code === '23505') return { ok: false, reason: 'exists' }
        throw new Error(`listing commit: ${error.message}`)
      }
      return { ok: true, ...(data as any) }
    },

    async touchExpiry(id, expiresAt) {
      must(await db.from('api_listing_state').update({ expires_at: expiresAt }).eq('tour_ref_id', id), 'touch expiry')
    },

    async countPriceChanges(id, since) {
      return count(db.from('api_audit_log').select('id', { count: 'exact', head: true })
        .eq('entity_type', 'listing').eq('entity_id', id).eq('action', 'listing.price_changed').gte('occurred_at', since), 'price changes')
    },

    async countApproved(partnerId, mode) {
      return count(db.from('api_listing_state').select('tour_ref_id', { count: 'exact', head: true })
        .eq('partner_id', partnerId).eq('mode', mode).or('reviewed_at.not.is.null,published_at.not.is.null'), 'approved listings')
    },

    async countActive(partnerId, mode) {
      return count(db.from('api_listing_state').select('tour_ref_id', { count: 'exact', head: true })
        .eq('partner_id', partnerId).eq('mode', mode).neq('publication_status', 'archived'), 'active listings')
    },

    async countRecentArchives(partnerId, mode, since) {
      return count(db.from('api_audit_log').select('id', { count: 'exact', head: true })
        .eq('partner_id', partnerId).eq('mode', mode).eq('action', 'listing.archived').gte('occurred_at', since), 'recent archives')
    },

    async findVehicleMatches(id, vinHash, chassisHash) {
      const ors = [vinHash && `vin_hash.eq.${vinHash}`, chassisHash && `chassis_hash.eq.${chassisHash}`].filter(Boolean)
      if (!ors.length) return []
      const rows = must(await db.from('api_listing_state').select('tour_ref_id')
        .or(ors.join(',')).neq('tour_ref_id', id).neq('publication_status', 'archived').limit(10), 'vehicle matches') as any[]
      return rows.map(r => r.tour_ref_id)
    },

    async duePurges(nowIso, limit) {
      return must(await db.from('api_listing_state').select(STATE_COLS)
        .eq('publication_status', 'archived').lt('restore_until', nowIso).order('restore_until').limit(limit), 'due purges') as StateRow[]
    },

    async dueExpiries(nowIso, limit) {
      return must(await db.from('api_listing_state').select(STATE_COLS)
        .eq('publication_status', 'published').lt('expires_at', nowIso).limit(limit), 'due expiries') as StateRow[]
    },

    async statesByStatus(status, before, limit) {
      return must(await db.from('api_listing_state').select(STATE_COLS)
        .eq('publication_status', status).lt('updated_at', before).order('updated_at').limit(limit), 'states by status') as StateRow[]
    },

    async moderationQueue(limit) {
      const rows = must(await db.from('api_listing_state')
        .select(`${STATE_COLS}, ref:api_partner_tours!inner(${REF_COLS}), partner:api_partners!inner(name)`)
        .eq('publication_status', 'pending_moderation').order('updated_at', { ascending: true }).limit(limit), 'moderation queue') as any[]
      return rows.map(r => ({ ...r, partner_name: r.partner?.name ?? '' }))
    },

    async mediaCounts(spaceId) {
      const [media, views] = await Promise.all([
        db.from('property_media').select('media_type, processing_status').eq('property_id', spaceId),
        db.from('vehicle_views').select('id', { count: 'exact', head: true }).eq('space_id', spaceId),
      ])
      const rows = (media.data ?? []) as { media_type: string; processing_status: string }[]
      const done = (t: string) => rows.filter(m => m.media_type === t && m.processing_status === 'complete').length
      return { photo: done('gallery_image'), panorama: done('panorama'), tour: 0, car_exterior: views.count ?? 0 }
    },

    async idemGet(partnerId, mode, key) {
      const r = await db.from('api_idempotency_keys').select('method, path, request_hash, status_code, response, expires_at')
        .eq('partner_id', partnerId).eq('mode', mode).eq('idem_key', key).maybeSingle()
      return (must(r, 'idempotency key') as IdemRow) ?? null
    },

    async idemInsert(partnerId, mode, key, row) {
      const { error } = await db.from('api_idempotency_keys').insert({ partner_id: partnerId, mode, idem_key: key, ...row })
      if (error?.code === '23505') return 'exists'
      if (error) throw new Error(`idempotency insert: ${error.message}`)
      return 'ok'
    },

    async idemFinish(partnerId, mode, key, status, response) {
      must(await db.from('api_idempotency_keys').update({ status_code: status, response })
        .eq('partner_id', partnerId).eq('mode', mode).eq('idem_key', key), 'idempotency finish')
    },

    async idemDelete(partnerId, mode, key) {
      await db.from('api_idempotency_keys').delete().eq('partner_id', partnerId).eq('mode', mode).eq('idem_key', key)
    },

    async purgeIdem(nowIso) {
      await db.from('api_idempotency_keys').delete().lt('expires_at', nowIso)
    },

    async listMedia(id) {
      return must(await db.from('api_listing_media').select(MEDIA_COLS).eq('tour_ref_id', id).order('sort_order').order('created_at'), 'listing media') as MediaRow[]
    },

    async listMediaFor(ids) {
      if (!ids.length) return []
      return must(await db.from('api_listing_media').select(MEDIA_COLS).in('tour_ref_id', ids).order('sort_order'), 'listing media') as MediaRow[]
    },

    async insertMedia(rows) {
      if (!rows.length) return
      must(await db.from('api_listing_media').upsert(rows, { onConflict: 'tour_ref_id,source_url', ignoreDuplicates: true }), 'insert media')
    },

    async updateMedia(id, patch) {
      must(await db.from('api_listing_media').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id), 'update media')
    },

    async claimDueMedia(nowIso, limit) {
      const due = must(await db.from('api_listing_media').select('id').eq('status', 'pending').lte('next_attempt_at', nowIso)
        .order('next_attempt_at').limit(limit), 'due media') as { id: string }[]
      const out: MediaRow[] = []
      for (const { id } of due) {
        const r = await db.from('api_listing_media').update({ status: 'fetching', locked_until: minutesFrom(nowIso, 5) })
          .eq('id', id).eq('status', 'pending').select(MEDIA_COLS).maybeSingle()
        if (r.data) out.push(r.data as MediaRow)
      }
      return out
    },

    async resetStuckMedia(nowIso) {
      await db.from('api_listing_media').update({ status: 'pending', locked_until: null }).eq('status', 'fetching').lt('locked_until', nowIso)
    },

    async failedMedia(limit) {
      return must(await db.from('api_listing_media').select(MEDIA_COLS).eq('status', 'failed').order('updated_at', { ascending: false }).limit(limit), 'failed media') as MediaRow[]
    },

    async findMediaBySha(id, sha) {
      const r = await db.from('api_listing_media').select(MEDIA_COLS).eq('tour_ref_id', id).eq('sha256', sha).eq('status', 'ready').limit(1).maybeSingle()
      return (r.data as MediaRow) ?? null
    },

    async insertEvents(partnerId, mode, events) {
      if (!events.length) return
      must(await db.from('api_outbox').insert(events.map(e => ({ partner_id: partnerId, mode, event_type: e.event_type, payload: e.payload }))), 'insert events')
    },

    async undispatched(limit) {
      return must(await db.from('api_outbox').select('*').is('dispatched_at', null).order('seq').limit(limit), 'outbox') as OutboxRow[]
    },

    async markDispatched(ids) {
      if (!ids.length) return
      must(await db.from('api_outbox').update({ dispatched_at: new Date().toISOString() }).in('id', ids), 'mark dispatched')
    },

    async getEvent(id) {
      const r = await db.from('api_outbox').select('*').eq('id', id).maybeSingle()
      return (r.data as OutboxRow) ?? null
    },

    async listWebhooks(partnerId, mode) {
      return must(await db.from('api_webhooks').select(WEBHOOK_COLS).eq('partner_id', partnerId).eq('mode', mode)
        .is('deleted_at', null).order('created_at'), 'webhooks') as WebhookRow[]
    },

    async getWebhook(id) {
      const r = await db.from('api_webhooks').select(WEBHOOK_COLS).eq('id', id).maybeSingle()
      return (r.data as WebhookRow) ?? null
    },

    async insertWebhook(row) {
      return must(await db.from('api_webhooks').insert(row).select(WEBHOOK_COLS).single(), 'insert webhook') as WebhookRow
    },

    async updateWebhook(id, patch) {
      must(await db.from('api_webhooks').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id), 'update webhook')
    },

    async insertDeliveries(rows) {
      if (!rows.length) return
      must(await db.from('api_webhook_deliveries').upsert(rows, { onConflict: 'webhook_id,event_id', ignoreDuplicates: true }), 'insert deliveries')
    },

    async claimDueDeliveries(nowIso, limit) {
      const due = must(await db.from('api_webhook_deliveries').select('id').eq('status', 'pending').lte('next_attempt_at', nowIso)
        .or(`locked_until.is.null,locked_until.lt.${nowIso}`).order('next_attempt_at').limit(limit), 'due deliveries') as { id: string }[]
      const out: DeliveryRow[] = []
      for (const { id } of due) {
        const r = await db.from('api_webhook_deliveries').update({ locked_until: minutesFrom(nowIso, 2) })
          .eq('id', id).eq('status', 'pending').or(`locked_until.is.null,locked_until.lt.${nowIso}`).select(DELIVERY_COLS).maybeSingle()
        if (r.data) out.push(r.data as DeliveryRow)
      }
      return out
    },

    async updateDelivery(id, patch) {
      must(await db.from('api_webhook_deliveries').update(patch).eq('id', id), 'update delivery')
    },

    async deliveries({ webhookId, status, limit }) {
      let q = db.from('api_webhook_deliveries').select(DELIVERY_COLS)
      if (webhookId) q = q.eq('webhook_id', webhookId)
      if (status) q = q.eq('status', status)
      return must(await q.order('created_at', { ascending: false }).limit(limit), 'deliveries') as DeliveryRow[]
    },

    async insertImport(row) {
      return must(await db.from('api_imports').insert(row).select(IMPORT_COLS).single(), 'insert import') as ImportRow
    },

    async getImport(id, partnerId, mode) {
      const r = await db.from('api_imports').select(IMPORT_COLS).eq('id', id).eq('partner_id', partnerId).eq('mode', mode).maybeSingle()
      return (must(r, 'import') as ImportRow) ?? null
    },

    async countOpenImports(partnerId, mode) {
      return count(db.from('api_imports').select('id', { count: 'exact', head: true })
        .eq('partner_id', partnerId).eq('mode', mode).in('status', ['queued', 'running']), 'open imports')
    },

    async claimImport(nowIso) {
      const open = must(await db.from('api_imports').select('id, partner_id, status, locked_until').in('status', ['queued', 'running'])
        .order('created_at').limit(50), 'open imports') as { id: string; partner_id: string; status: string; locked_until: string | null }[]
      // One import at a time per partner: skip a partner whose earlier import is still open.
      const seen = new Set<string>()
      for (const imp of open) {
        if (seen.has(imp.partner_id)) continue
        seen.add(imp.partner_id)
        if (imp.locked_until && imp.locked_until > nowIso) continue
        const r = await db.from('api_imports').update({ locked_until: minutesFrom(nowIso, 2) })
          .eq('id', imp.id).in('status', ['queued', 'running']).or(`locked_until.is.null,locked_until.lt.${nowIso}`)
          .select(IMPORT_COLS).maybeSingle()
        if (r.data) return r.data as ImportRow
      }
      return null
    },

    async updateImport(id, patch) {
      must(await db.from('api_imports').update(patch).eq('id', id), 'update import')
    },

    async failedImports(limit) {
      return must(await db.from('api_imports').select(IMPORT_COLS).eq('status', 'failed').order('created_at', { ascending: false }).limit(limit), 'failed imports') as ImportRow[]
    },

    async insertAudit(row) {
      must(await db.from('api_audit_log').insert({
        partner_id: row.partner_id, mode: row.mode, actor_type: row.actor_type, actor_id: row.actor_id, action: row.action,
        entity_type: row.entity_type, entity_id: row.entity_id, changes: row.changes, request_id: row.request_id ?? null,
      }), 'audit')
    },

    async leads(partnerId, mode, q) {
      let query = db.from('leads')
        .select('id, property_id, name, email, phone, message, source, created_at, properties!inner(api_partner_tours!inner(id, external_id, partner_id, mode)), api_lead_consents!inner(wording, accepted, created_at, withdrawn_at, partner_id)')
        .eq('properties.api_partner_tours.partner_id', partnerId).eq('properties.api_partner_tours.mode', mode)
        // Only buyers who agreed to share their details with this partner.
        .eq('api_lead_consents.partner_id', partnerId).eq('api_lead_consents.accepted', true).is('api_lead_consents.withdrawn_at', null)
      if (q.spaceId) query = query.eq('property_id', q.spaceId)
      if (q.since) query = query.gte('created_at', q.since)
      if (q.after) query = query.or(afterCondition('created_at', q.after, 'id', true))
      const rows = must(await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(q.limit), 'leads') as any[]
      return rows.map(r => {
        const refs = r.properties?.api_partner_tours
        const ref = Array.isArray(refs) ? refs[0] : refs
        const c = Array.isArray(r.api_lead_consents) ? r.api_lead_consents[0] : r.api_lead_consents
        return { id: r.id, space_id: r.property_id, ref: { id: ref?.id, external_id: ref?.external_id }, name: r.name, email: r.email,
          phone: r.phone, message: r.message, source: r.source, created_at: r.created_at, consent: { wording: c?.wording, given_at: c?.created_at } }
      })
    },

    async analytics(partnerId, mode, q) {
      let query = db.from('analytics_daily')
        .select('*, properties!inner(api_partner_tours!inner(id, external_id, partner_id, mode))')
        .eq('properties.api_partner_tours.partner_id', partnerId).eq('properties.api_partner_tours.mode', mode)
        .gte('date', q.from).lte('date', q.to)
      if (q.spaceId) query = query.eq('property_id', q.spaceId)
      const rows = must(await query.order('date').limit(10_000), 'analytics') as any[]
      return rows.map(r => {
        const refs = r.properties?.api_partner_tours
        const ref = Array.isArray(refs) ? refs[0] : refs
        const counts: Record<string, number> = {}
        for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'id') counts[k] = v
        return { space_id: r.property_id, ref: { id: ref?.id, external_id: ref?.external_id }, date: r.date, counts }
      })
    },

    async exportSpaces(partnerId, mode, q) {
      const rows = must(await db.rpc('api_export_spaces', {
        p_partner: partnerId, p_mode: mode, p_after_t: q.after?.t ?? null, p_after_id: q.after?.id ?? null, p_limit: q.limit,
      }), 'export') as any[]
      const keys = EXPORT_COLS.split(', ')
      return (rows ?? []).map(r => Object.fromEntries(keys.map(k => [k, r[k] ?? null])) as ExportSpace)
    },

    async agentsByUsers(partnerId, mode, userIds) {
      if (!userIds.length) return []
      return must(await db.from('api_partner_agents').select(AGENT_COLS).eq('partner_id', partnerId).eq('mode', mode).in('user_id', userIds), 'agents by user') as AgentLite[]
    },

    async agentsForUser(userId) {
      const rows = must(await db.from('api_partner_agents').select(`${AGENT_COLS}, api_partners(name)`).eq('user_id', userId), 'agents for user') as any[]
      return rows.map(({ api_partners, ...a }) => ({ ...a, partner_name: api_partners?.name ?? 'A partner' }))
    },

    async insertClaim(row) {
      const r = await db.from('api_listing_claims').insert(row).select(CLAIM_COLS).single()
      if (r.error?.code === '23505') return 'duplicate'
      return must(r, 'insert claim') as ClaimRow
    },

    async getClaim(id) {
      return (must(await db.from('api_listing_claims').select(CLAIM_COLS).eq('id', id).maybeSingle(), 'claim') as ClaimRow) ?? null
    },

    async listClaims(f) {
      let q = db.from('api_listing_claims').select(CLAIM_COLS)
      if (f.partnerId) q = q.eq('partner_id', f.partnerId)
      if (f.mode) q = q.eq('mode', f.mode)
      if (f.agentIds) { if (!f.agentIds.length) return []; q = q.in('agent_id', f.agentIds) }
      if (f.status) q = q.eq('status', f.status)
      return must(await q.order('created_at', { ascending: false }).limit(f.limit), 'claims') as ClaimRow[]
    },

    async decideClaim(id, status, by, nowIso) {
      const r = await db.from('api_listing_claims').update({ status, decided_by: by, decided_at: nowIso })
        .eq('id', id).eq('status', 'pending').select(CLAIM_COLS).maybeSingle()
      return (must(r, 'decide claim') as ClaimRow) ?? null
    },

    async dueClaimExpiries(nowIso, limit) {
      return must(await db.from('api_listing_claims').select(CLAIM_COLS).eq('status', 'pending').lt('expires_at', nowIso).limit(limit), 'due claims') as ClaimRow[]
    },

    async activeText(key, locale) {
      const r = await db.from('api_texts').select(TEXT_COLS).eq('key', key).eq('locale', locale).eq('active', true).maybeSingle()
      return (must(r, 'text') as TextRow) ?? null
    },

    async listTexts() {
      return must(await db.from('api_texts').select(TEXT_COLS).order('key').order('locale').order('version', { ascending: false }).limit(200), 'texts') as TextRow[]
    },

    async saveText(row) {
      const cur = must(await db.from('api_texts').select('version').eq('key', row.key).eq('locale', row.locale)
        .order('version', { ascending: false }).limit(1), 'text versions') as { version: number }[]
      must(await db.from('api_texts').update({ active: false }).eq('key', row.key).eq('locale', row.locale).eq('active', true), 'retire text')
      return must(await db.from('api_texts').insert({ ...row, version: (cur[0]?.version ?? 0) + 1, active: true }).select(TEXT_COLS).single(), 'save text') as TextRow
    },

    async insertConsent(row) {
      must(await db.from('api_lead_consents').insert(row), 'consent')
    },

    async withdrawConsent(leadId, nowIso) {
      const r = await db.from('api_lead_consents').update({ withdrawn_at: nowIso }).eq('lead_id', leadId).is('withdrawn_at', null).select('id')
      return (must(r, 'withdraw consent') as any[]).length > 0
    },
  }
}
