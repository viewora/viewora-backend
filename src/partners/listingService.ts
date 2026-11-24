import type { KeyMode } from '../utils/partnerKeys.js'
import {
  checkPatchOwnership, hashVehicleId, isRiskyPriceChange, isStaleUpdate, listingInputSchema, listingPatchSchema,
  mergePatch, publishBlockers, toCarIdentity, toSpaceFacts, toStateRow,
  type ListingInput, type MediaCounts, type PublicationStatus,
} from './listingModel.js'
import type { AgentRow, Partner, PartnerStore, SpaceSummary, TourRefRow } from './store.js'
import type { EventInput, ListingStore, MediaRow, NewMedia, Reason, StateRow, StoredListing } from './listingStore.js'
import type { TourGateway, UploadKind } from './tourGateway.js'
import type { z } from 'zod'

// The listing API's rules, independent of HTTP. Routes, the bulk import
// worker and the admin moderation queue all go through these functions.

/** Starting values from the strategy doc; tune with real data. Not prices. */
export const LISTING_RULES = {
  /** A live partner's first listings wait for a person before going live. */
  firstListingsReviewed: 50,
  /** No update or confirmation for this long and a listing expires. */
  expiryDays: { rent: 60, lease: 60, sale: 90 } as Record<string, number>,
  restoreDays: 30,
  /** Archiving more than 10% of active listings within an hour is held (a broken export looks like a mass delete). */
  bulkDeleteHold: { windowMs: 3600_000, maxShare: 0.10, minActive: 20 },
  bulkMaxItems: 500,
  /** 1 running and 3 queued. */
  maxOpenImports: 4,
  defaultLiveListingLimit: 2000,
} as const

/** Media kinds the fetch worker turns into tour media. Others are kept on the listing but not processed in v1. */
export const FETCHED_KINDS: Record<string, UploadKind | undefined> = { photo: 'photo', panorama: 'panorama', car_exterior: 'car_exterior' }

export type Actor = { type: 'partner_key' | 'staff' | 'system'; id: string | null; requestId?: string | null }
export type Ctx = { partner: Partner; mode: KeyMode; actor: Actor }
export type Result = { status: number; body: any }

export type ListingDeps = {
  partners: PartnerStore
  listings: ListingStore
  tours: TourGateway
  appUrl: string
  now?: () => number
  log?: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }
}

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): Result =>
  ({ status, body: { error: { code, message, ...(extra ?? {}) } } })

export function zodFields(error: z.ZodError) {
  return error.issues.map(i => ({ field: i.path.join('.') || 'body', message: i.message }))
}

/** Stable JSON for comparisons (key order does not matter). */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter(k => (v as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b)

// ── stored form ─────────────────────────────────────────────────────────────

/** The listing as stored: the raw VIN and chassis number are replaced by their last 4 characters. */
export function sanitize(l: ListingInput, keepIds?: StoredListing['_ids']): StoredListing {
  if (!l.vehicle) return { ...l }
  const { vin, chassis_no, ...vehicle } = l.vehicle
  const ids = { ...(keepIds ?? {}) }
  if (vin) ids.vin_last4 = vin.slice(-4)
  if (chassis_no) ids.chassis_last4 = chassis_no.slice(-4)
  const out: StoredListing = { ...l, vehicle: vehicle as ListingInput['vehicle'] }
  if (Object.keys(ids).length) out._ids = ids
  return out
}

export function toInput(s: StoredListing): ListingInput {
  const { _ids, ...rest } = s as any
  return rest as ListingInput
}

/** Listing ids in paths: lst_<uuid> (Viewora's) or ext:<external_id> (the partner's). */
export function parseListingId(raw: string): { refId: string } | { externalId: string } | null {
  const lst = /^lst_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw)
  if (lst) return { refId: lst[1].toLowerCase() }
  if (raw.startsWith('ext:')) {
    const ext = raw.slice(4)
    return /^[A-Za-z0-9._:\-]{1,120}$/.test(ext) ? { externalId: ext } : null
  }
  return null
}

const PHONE_RE = /(?:\+?254|\b0)[\s-]?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i

/** Phone numbers, emails or links in the title or description (contact must go through Viewora's lead form). */
export function contactDetailsInText(l: Pick<ListingInput, 'title' | 'description'>): boolean {
  const text = `${l.title}\n${l.description ?? ''}`
  return PHONE_RE.test(text) || EMAIL_RE.test(text) || URL_RE.test(text)
}

export type Decision = { status: PublicationStatus; reasons: Reason[]; live: boolean }

/** Where the listing should be in its publication lifecycle, given its media and any review reasons. */
export function decide(l: ListingInput, media: MediaCounts, pendingMedia: number, review: Reason[]): Decision {
  if (!l.publish || l.availability === 'withdrawn') return { status: 'draft', reasons: [], live: false }
  const blockers = publishBlockers(l, media)
  if (blockers.length) {
    if (pendingMedia > 0 && blockers.every(b => b.code === 'NOT_ENOUGH_MEDIA')) {
      return { status: 'submitted', reasons: [{ code: 'WAITING_FOR_MEDIA', field: 'media', message: 'Photos are still being fetched; the listing goes live when they are ready', by: 'system' }], live: false }
    }
    return { status: 'rejected', reasons: blockers.map(b => ({ ...b, by: 'system' as const })), live: false }
  }
  if (review.length) return { status: 'pending_moderation', reasons: review, live: false }
  return { status: 'published', reasons: [], live: true }
}

function diff(before: StoredListing | null, after: StoredListing): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)])
  for (const k of keys) {
    const b = (before as any)?.[k], a = (after as any)[k]
    if (!same(b, a)) out[k] = [b ?? null, a ?? null]
  }
  return out
}

function mediaWanted(l: ListingInput): { kind: string; source_url: string; sort_order: number; caption: string | null; angle: number | null }[] {
  const seen = new Set<string>()
  const out = []
  for (const [i, m] of (l.media ?? []).entries()) {
    if (!m.source_url || seen.has(m.source_url)) continue
    seen.add(m.source_url)
    out.push({ kind: m.kind, source_url: m.source_url, sort_order: m.order ?? i, caption: m.caption ?? null, angle: m.angle ?? null })
  }
  return out
}

// ── the service ─────────────────────────────────────────────────────────────

export function listingService(deps: ListingDeps) {
  const { partners, listings, tours } = deps
  const now = () => (deps.now ? deps.now() : Date.now())
  const iso = (ms = now()) => new Date(ms).toISOString()
  const appUrl = deps.appUrl.replace(/\/$/, '')

  // ── output ──
  function out(ref: TourRefRow, s: StateRow, space?: SpaceSummary | null, media?: MediaRow[]) {
    const l = toInput(s.listing)
    const ids = s.listing._ids
    const vehicle = l.vehicle ? {
      ...l.vehicle,
      ...(ids?.vin_last4 ? { vin_masked: `•••••••••••••${ids.vin_last4}` } : {}),
      ...(ids?.chassis_last4 ? { chassis_no_masked: `••••${ids.chassis_last4}` } : {}),
    } : undefined
    const live = s.publication_status === 'published' && space?.is_published && space.slug
    return {
      ...l,
      id: `lst_${ref.id}`,
      external_id: ref.external_id,
      tour_id: ref.space_id,
      version: s.version,
      ...(vehicle ? { vehicle } : {}),
      media: (media ?? []).filter(m => m.status !== 'removed').map(m => ({
        id: m.id, kind: m.kind, source_url: m.source_url, order: m.sort_order, caption: m.caption, angle: m.angle, status: m.status,
        ...(m.error_code ? { error: { code: m.error_code, message: m.error_message } } : {}),
      })),
      publication_status: s.publication_status,
      moderation: { reasons: s.moderation_reasons ?? [], pending_change: Boolean(s.pending_listing) },
      urls: { share: live ? `${appUrl}/p/${space!.slug}` : null, embed: live ? `${appUrl}/embed/${space!.slug}` : null },
      published_at: s.published_at,
      expires_at: s.expires_at,
      archived_at: s.archived_at,
      restore_until: s.restore_until,
      partner_updated_at: s.partner_updated_at,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }
  }

  async function outOne(ref: TourRefRow, s: StateRow) {
    const [[space], media] = await Promise.all([partners.getSpaces([ref.space_id]), listings.listMedia(ref.id)])
    return out(ref, s, space ?? null, media)
  }

  async function outMany(rows: { ref: TourRefRow; state: StateRow }[]) {
    const [spaces, media] = await Promise.all([
      partners.getSpaces(rows.map(r => r.ref.space_id)),
      listings.listMediaFor(rows.map(r => r.ref.id)),
    ])
    const sById = new Map(spaces.map(s => [s.id, s]))
    return rows.map(r => out(r.ref, r.state, sById.get(r.ref.space_id) ?? null, media.filter(m => m.tour_ref_id === r.ref.id)))
  }

  // ── lookups ──
  async function resolve(ctx: Ctx, rawId: string) {
    const id = parseListingId(rawId)
    if (!id) return null
    const ref = await partners.getTourRef(ctx.partner.id, ctx.mode, 'refId' in id ? { id: id.refId } : { externalId: id.externalId })
    if (!ref) return null
    const [state, agents] = await Promise.all([listings.getState(ref.id), partners.getAgentsByIds([ref.agent_id])])
    if (!agents[0]) return null
    return { ref, state, agent: agents[0] }
  }

  const notFound = () => fail(404, 'LISTING_NOT_FOUND', 'No listing with this id for your account.')

  // ── moderation ──
  async function reviewReasons(ctx: Ctx, ref: TourRefRow, prev: StateRow | null, l: ListingInput, hashes: { vin: string | null; chassis: string | null }): Promise<Reason[]> {
    // Sandbox (test keys): no moderation delay.
    if (ctx.mode === 'test' || ctx.actor.type === 'staff') return []
    const reasons: Reason[] = []
    const approved = Boolean(prev?.reviewed_at)
    if (!approved && !prev?.published_at && (await listings.countApproved(ctx.partner.id, ctx.mode)) < LISTING_RULES.firstListingsReviewed) {
      reasons.push({ code: 'FIRST_LISTINGS_REVIEW', message: `A partner's first ${LISTING_RULES.firstListingsReviewed} live listings are checked by Viewora before going live (usually within 4 working hours)`, by: 'system' })
    }
    const textChanged = !prev || prev.listing.title !== l.title || (prev.listing.description ?? null) !== (l.description ?? null)
    if (contactDetailsInText(l) && (!approved || textChanged)) {
      reasons.push({ code: 'CONTACT_DETAILS_IN_TEXT', field: 'description', message: 'Phone numbers, emails and links in the title or description are checked by a person; buyers contact the agent through the Viewora page', by: 'system' })
    }
    const hashChanged = !prev || prev.vin_hash !== hashes.vin || prev.chassis_hash !== hashes.chassis
    if ((hashes.vin || hashes.chassis) && (!approved || hashChanged)) {
      const matches = await listings.findVehicleMatches(ref.id, hashes.vin, hashes.chassis)
      if (matches.length) reasons.push({ code: 'POSSIBLE_DUPLICATE', field: 'vehicle', message: 'Another listing on Viewora has the same VIN or chassis number', by: 'system' })
    }
    if (prev?.publication_status === 'rejected' && (prev.moderation_reasons ?? []).some(r => r.by === 'moderator')) {
      reasons.push({ code: 'RESUBMITTED_AFTER_REJECTION', message: 'A moderator rejected this listing earlier; the change is checked again', by: 'system' })
    }
    return reasons
  }

  function expiryFor(l: ListingInput, status: PublicationStatus) {
    return status === 'published' ? iso(now() + (LISTING_RULES.expiryDays[l.transaction] ?? 90) * 86400_000) : null
  }

  function eventFor(type: string, ref: TourRefRow, version: number, status: PublicationStatus, l: ListingInput, reasons: Reason[] = []): EventInput {
    return {
      event_type: type,
      payload: { listing: { id: `lst_${ref.id}`, external_id: ref.external_id, version, publication_status: status, availability: l.availability, ...(reasons.length ? { reasons } : {}) } },
    }
  }

  /** Brings the tour's media in line with the listing's media list (new URLs queued, dropped ones removed). */
  async function syncMedia(ctx: Ctx, ref: TourRefRow, agent: AgentRow, l: ListingInput, replace: boolean) {
    if (!l.media && !replace) return
    const wanted = mediaWanted(l)
    const existing = await listings.listMedia(ref.id)
    const byUrl = new Map(existing.map(m => [m.source_url, m]))
    const fresh: NewMedia[] = []
    for (const w of wanted) {
      const e = byUrl.get(w.source_url)
      if (!e) {
        const processed = Boolean(FETCHED_KINDS[w.kind])
        fresh.push({
          tour_ref_id: ref.id, partner_id: ctx.partner.id, mode: ctx.mode, ...w,
          ...(processed ? {} : { status: 'skipped', error_code: 'KIND_NOT_PROCESSED', error_message: w.kind === 'document' ? 'Documents are private and are not published through the API' : `${w.kind} files are not processed through the API yet; upload tours and 360 photos with /v1/tours` }),
        })
      } else if (e.status === 'removed') {
        await listings.updateMedia(e.id, { status: 'pending', attempts: 0, next_attempt_at: iso(), error_code: null, error_message: null, sort_order: w.sort_order, caption: w.caption })
      } else if (e.sort_order !== w.sort_order || e.caption !== w.caption) {
        await listings.updateMedia(e.id, { sort_order: w.sort_order, caption: w.caption })
      }
    }
    await listings.insertMedia(fresh)
    if (!replace) return
    const keep = new Set(wanted.map(w => w.source_url))
    for (const e of existing) {
      if (keep.has(e.source_url) || e.status === 'removed') continue
      if (e.status === 'ready') await tours.removeMedia(agent.user_id, e).catch(err => deps.log?.warn({ err: String(err) }, 'partner media remove failed'))
      await listings.updateMedia(e.id, { status: 'removed' })
    }
  }

  /**
   * Media the publish rules count. A photo fetched a moment ago may still be
   * processing on the tour, so take the larger of the tour's processed count
   * and the files the worker has already stored.
   */
  async function mediaState(ref: TourRefRow) {
    const [tour, rows] = await Promise.all([listings.mediaCounts(ref.space_id), listings.listMedia(ref.id)])
    const ready = (k: string) => rows.filter(m => m.status === 'ready' && m.kind === k).length
    const counts: MediaCounts = {
      photo: Math.max(tour.photo, ready('photo')),
      panorama: Math.max(tour.panorama, ready('panorama')),
      tour: tour.tour,
      car_exterior: Math.max(tour.car_exterior, ready('car_exterior')),
    }
    const pending = rows.filter(m => m.status === 'pending' || m.status === 'fetching').length
    return { counts, pending, fetchedReady: rows.filter(m => m.status === 'ready').length }
  }

  /** The tour refuses to publish until a photo has finished processing; give it an hour. */
  const WAIT_FOR_PROCESSING_MS = 3600_000

  /**
   * Decides the publication state, publishes or unpublishes the tour, and
   * commits the state row with its audit row and events in one transaction.
   */
  async function persist(ctx: Ctx, a: {
    ref: TourRefRow; agent: AgentRow; prev: StateRow | null; listing: ListingInput; action: string; events: string[]
    importId?: string | null; reviewedBy?: string | null; skipReview?: boolean
  }): Promise<Result> {
    const { ref, agent, prev, listing } = a
    const vinHash = listing.vehicle?.vin ? hashVehicleId(listing.vehicle.vin) : (listing.vehicle ? prev?.vin_hash ?? null : null)
    const chassisHash = listing.vehicle?.chassis_no ? hashVehicleId(listing.vehicle.chassis_no) : (listing.vehicle ? prev?.chassis_hash ?? null : null)
    const stored = sanitize(listing, listing.vehicle ? prev?.listing._ids : undefined)

    const { counts, pending, fetchedReady } = await mediaState(ref)
    const review = a.skipReview ? [] : await reviewReasons(ctx, ref, prev, listing, { vin: vinHash, chassis: chassisHash })
    let d = decide(listing, counts, pending, review)

    const [space] = await partners.getSpaces([ref.space_id])
    const isLive = Boolean(space?.is_published)
    if (d.live !== isLive) {
      const r = await tours.setPublished(agent.user_id, ref.space_id, d.live)
      if (!r.ok && d.live) {
        const waitedSince = prev?.publication_status === 'submitted' ? Date.parse(prev.updated_at) : now()
        const stillProcessing = fetchedReady > 0 && /before publishing/i.test(r.message) && now() - waitedSince < WAIT_FOR_PROCESSING_MS
        d = stillProcessing
          ? { status: 'submitted', live: false, reasons: [{ code: 'WAITING_FOR_MEDIA', field: 'media', message: 'Photos are still processing; the listing goes live when they are ready', by: 'system' }] }
          : { status: 'rejected', live: false, reasons: [{ code: 'TOUR_PUBLISH_FAILED', message: r.message, by: 'system' }] }
      } else if (!r.ok) deps.log?.error({ ref: ref.id, message: r.message }, 'partner tour unpublish failed')
    }

    const nextVersion = (prev?.version ?? 0) + 1
    const types = [...a.events]
    const was = prev?.publication_status
    if (d.status !== was) {
      if (d.status === 'published') types.push('listing.published')
      else if (was === 'published') types.push('listing.unpublished')
      if (d.status === 'pending_moderation') types.push('listing.moderation_held')
      if (d.status === 'rejected') types.push('listing.rejected')
    }
    const priceChanged = Boolean(prev) && !same(prev!.listing.price ?? null, listing.price ?? null)
    const state = {
      ...toStateRow(listing, ref.id, ctx.actor.type === 'staff' ? 'admin' : ctx.actor.type === 'system' ? 'system' : 'api'),
      vin_hash: vinHash,
      chassis_hash: chassisHash,
      listing: stored,
      pending_listing: null,
      publication_status: d.status,
      moderation_reasons: d.reasons,
      published_at: d.status === 'published' ? (prev?.published_at ?? iso()) : (prev?.published_at ?? null),
      expires_at: expiryFor(listing, d.status),
      archived_at: null,
      restore_until: null,
      last_import_id: a.importId ?? prev?.last_import_id ?? null,
      partner_updated_at: listing.partner_updated_at ?? prev?.partner_updated_at ?? null,
      ...(a.reviewedBy ? { reviewed_at: iso(), reviewed_by: a.reviewedBy } : {}),
    }
    const audit = {
      actor_type: ctx.actor.type, actor_id: ctx.actor.id, request_id: ctx.actor.requestId ?? null,
      action: priceChanged ? 'listing.price_changed' : a.action,
      changes: { ...diff(prev?.listing ?? null, stored), ...(was !== d.status ? { publication_status: [was ?? null, d.status] } : {}) },
    }
    const events = [...new Set(types)].map(t => eventFor(t, ref, nextVersion, d.status, listing, d.reasons))
    const res = await listings.commit(ref.id, prev ? prev.version : null, state, audit, events)
    if (!res.ok) {
      // Someone else changed the listing between our read and write. Put
      // the tour back in line with whatever won, then tell the caller.
      await resyncTour(ref, agent).catch(() => {})
      if (res.reason === 'exists') return fail(409, 'LISTING_EXISTS', 'A listing with this external_id already exists.')
      if (res.reason === 'conflict') return fail(409, 'VERSION_CONFLICT', 'The listing changed while this update was running. Read it again and retry.')
      return notFound()
    }
    const saved = await listings.getState(ref.id)
    return { status: prev ? 200 : 201, body: { listing: await outOne(ref, saved!), applied: true, changed: true } }
  }

  /** Makes the tour match the stored listing (after a lost race or an approval). */
  async function resyncTour(ref: TourRefRow, agent: AgentRow) {
    const s = await listings.getState(ref.id)
    if (!s?.listing?.title) return
    const l = toInput(s.listing)
    await tours.updateSpace(agent.user_id, ref.space_id, toSpaceFacts(l))
    const [space] = await partners.getSpaces([ref.space_id])
    const live = s.publication_status === 'published'
    if (space && Boolean(space.is_published) !== live) await tours.setPublished(agent.user_id, ref.space_id, live)
  }

  async function pushTour(agent: AgentRow, ref: TourRefRow, l: ListingInput, prev: ListingInput | null): Promise<Result | null> {
    const facts = toSpaceFacts(l)
    const prevFacts = prev ? toSpaceFacts(prev) : null
    if (!prevFacts || !same(prevFacts, facts)) {
      const r = await tours.updateSpace(agent.user_id, ref.space_id, facts)
      if (!r.ok) return fail(r.status, r.code, r.message)
    }
    const car = toCarIdentity(l)
    const prevCar = prev ? toCarIdentity(prev) : null
    if (car && (!prevCar || !same({ ...car, vin: undefined }, { ...prevCar, vin: undefined }) || (car.vin && car.vin !== prevCar.vin))) {
      // Never clear a VIN the partner did not resend.
      const identity = car.vin ? car : { make: car.make, model: car.model, trim: car.trim }
      const r = await tours.setCarIdentity(agent.user_id, ref.space_id, identity as any)
      if (!r.ok) deps.log?.warn({ ref: ref.id, message: r.message }, 'partner car identity not saved')
    }
    return null
  }

  // ── create ──
  async function create(ctx: Ctx, body: unknown, opts: { importId?: string | null } = {}): Promise<Result> {
    const parsed = listingInputSchema.safeParse(body)
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { fields: zodFields(parsed.error) })
    const l = parsed.data
    if (!l.agent_external_id) {
      return fail(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { fields: [{ field: 'agent_external_id', message: 'Required: the agent or dealer this listing belongs to (create them with POST /v1/agents)' }] })
    }
    const agent = await partners.getAgent(ctx.partner.id, ctx.mode, l.agent_external_id)
    if (!agent) return fail(404, 'AGENT_NOT_FOUND', 'No agent with this agent_external_id. Create it with POST /v1/agents first.')

    let ref = await partners.getTourRef(ctx.partner.id, ctx.mode, { externalId: l.external_id })
    if (ref) {
      const st = await listings.getState(ref.id)
      if (st) return fail(409, 'LISTING_EXISTS', 'A listing with this external_id already exists. Update it with PATCH.', { listing: await outOne(ref, st) })
      // A tour made earlier with POST /v1/tours under the same external_id becomes this listing.
      if (ref.agent_id !== agent.id) return fail(409, 'TOUR_AGENT_MISMATCH', 'A tour with this external_id exists under a different agent.')
    }
    if (ctx.mode === 'live') {
      const limit = ctx.partner.max_live_listings ?? LISTING_RULES.defaultLiveListingLimit
      if ((await listings.countActive(ctx.partner.id, 'live')) >= limit) {
        return fail(403, 'LISTING_LIMIT_REACHED', `Your agreement includes ${limit} live listings. Archive some or contact Viewora to add more.`, { limit })
      }
    }

    if (ref) {
      const r = await tours.updateSpace(agent.user_id, ref.space_id, toSpaceFacts(l))
      if (!r.ok) return fail(r.status, r.code, r.message)
    } else {
      const space = await tours.createSpace(agent.user_id, toSpaceFacts(l))
      if (!space.ok) return fail(space.status, space.code, space.message)
      const inserted = await partners.insertTourRef({ partner_id: ctx.partner.id, mode: ctx.mode, external_id: l.external_id, space_id: space.id, agent_id: agent.id })
      if (inserted === 'duplicate') {
        await tours.deleteSpace(agent.user_id, space.id).catch(() => {})
        return fail(409, 'LISTING_EXISTS', 'A listing with this external_id already exists.')
      }
      ref = inserted
    }
    const car = toCarIdentity(l)
    if (car) {
      const r = await tours.setCarIdentity(agent.user_id, ref.space_id, car)
      if (!r.ok) deps.log?.warn({ ref: ref.id, message: r.message }, 'partner car identity not saved')
    }
    await syncMedia(ctx, ref, agent, l, false)
    return persist(ctx, { ref, agent, prev: null, listing: l, action: 'listing.created', events: ['listing.created'], importId: opts.importId })
  }

  // ── update ──
  async function patch(ctx: Ctx, rawId: string, body: unknown, ifMatch: number | null, opts: { importId?: string | null } = {}): Promise<Result> {
    const found = await resolve(ctx, rawId)
    if (!found?.state) return notFound()
    const { ref, state, agent } = found
    const own = checkPatchOwnership(body, state.change_origin === 'app' ? 'app' : 'api')
    if (!own.ok) return fail(own.status, own.code, own.message, own.fields.length ? { fields: own.fields } : undefined)
    if (ifMatch !== null && ifMatch !== state.version) {
      return fail(409, 'VERSION_CONFLICT', `The listing is at version ${state.version}; your If-Match was ${ifMatch}. Read it again and retry.`, { current_version: state.version })
    }
    if (state.pending_listing) return fail(423, 'LISTING_LOCKED', 'A change to this listing is waiting for review. Try again after the review (usually within 4 working hours).')
    if (state.publication_status === 'archived') return fail(409, 'LISTING_ARCHIVED', 'This listing is archived. Restore it first with POST /v1/listings/{id}/restore.')

    const parsed = listingPatchSchema.safeParse(body)
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { fields: zodFields(parsed.error) })
    const p = parsed.data
    if (isStaleUpdate(state.partner_updated_at, p.partner_updated_at)) {
      return { status: 200, body: { listing: await outOne(ref, state), applied: false, reason: 'stale' } }
    }
    if (p.agent_external_id && p.agent_external_id !== state.listing.agent_external_id) {
      return fail(409, 'AGENT_CHANGE_NOT_SUPPORTED', 'Moving a listing to another agent is not supported yet. Archive it and create it again under the new agent.')
    }
    const before = toInput(state.listing)
    const merged = mergePatch(before, p)
    if (!merged.ok) return fail(400, 'VALIDATION_ERROR', 'The listing would not be valid after this change.', { fields: zodFields(merged.error) })
    const l = merged.listing

    const newVin = l.vehicle?.vin ? hashVehicleId(l.vehicle.vin) : state.vin_hash
    const newChassis = l.vehicle?.chassis_no ? hashVehicleId(l.vehicle.chassis_no) : state.chassis_hash
    const storedNext = sanitize(l, state.listing._ids)
    const unchanged = same(storedNext, state.listing) && newVin === state.vin_hash && newChassis === state.chassis_hash
    if (unchanged && ['published', 'draft', 'pending_moderation', 'submitted'].includes(state.publication_status)) {
      // A re-send confirms the listing is still current: push expiry out.
      if (state.publication_status === 'published') await listings.touchExpiry(ref.id, expiryFor(l, 'published'))
      const fresh = (await listings.getState(ref.id)) ?? state
      return { status: 200, body: { listing: await outOne(ref, fresh), applied: true, changed: false } }
    }

    // Bait pricing: a large drop, a currency change or frequent changes on a
    // live listing are held for a person; the page keeps the old price.
    const priceChanged = !same(before.price ?? null, l.price ?? null)
    if (priceChanged && ctx.mode === 'live' && state.publication_status === 'published') {
      const changes = await listings.countPriceChanges(ref.id, iso(now() - 86400_000))
      if (isRiskyPriceChange(before.price, l.price, changes)) {
        const reasons: Reason[] = [{ code: 'PRICE_CHANGE_REVIEW', field: 'price', message: 'Large price drops, currency changes and frequent price changes are checked by a person before they show', by: 'system' }]
        const res = await listings.commit(ref.id, state.version, {
          pending_listing: storedNext, publication_status: 'pending_moderation', moderation_reasons: reasons,
          partner_updated_at: l.partner_updated_at ?? state.partner_updated_at,
        }, {
          actor_type: ctx.actor.type, actor_id: ctx.actor.id, request_id: ctx.actor.requestId ?? null,
          action: 'listing.price_changed', changes: { price: [before.price ?? null, l.price ?? null], held_for_review: [false, true] },
        }, [eventFor('listing.moderation_held', ref, state.version + 1, 'pending_moderation', before, reasons)])
        if (!res.ok) return fail(409, 'VERSION_CONFLICT', 'The listing changed while this update was running. Read it again and retry.')
        // The tour keeps showing the current listing while the change waits.
        const saved = await listings.getState(ref.id)
        return { status: 202, body: { listing: await outOne(ref, saved!), applied: false, held_for_review: true } }
      }
    }

    const tourErr = await pushTour(agent, ref, l, before)
    if (tourErr) return tourErr
    if (p.media !== undefined) await syncMedia(ctx, ref, agent, l, true)
    return persist(ctx, { ref, agent, prev: state, listing: l, action: 'listing.updated', events: ['listing.updated'], importId: opts.importId })
  }

  /** Bulk item: update when the external_id exists, otherwise create. */
  async function upsert(ctx: Ctx, item: any, importId: string | null): Promise<{ outcome: 'created' | 'updated' | 'unchanged' | 'failed'; result: Result }> {
    const ext = typeof item?.external_id === 'string' ? item.external_id : null
    const ref = ext ? await partners.getTourRef(ctx.partner.id, ctx.mode, { externalId: ext }) : null
    const state = ref ? await listings.getState(ref.id) : null
    if (ref && state) {
      const { external_id, vertical, ...rest } = item
      if (vertical !== undefined && vertical !== state.vertical) {
        return { outcome: 'failed', result: fail(409, 'FIELD_IMMUTABLE', 'vertical cannot change after a listing is created.', { fields: ['vertical'] }) }
      }
      const r = await patch(ctx, `ext:${ext}`, rest, null, { importId })
      return { outcome: r.status >= 400 ? 'failed' : r.body?.changed === false || r.body?.applied === false ? 'unchanged' : 'updated', result: r }
    }
    const r = await create(ctx, item, { importId })
    return { outcome: r.status >= 400 ? 'failed' : 'created', result: r }
  }

  /** Bulk dry run: what would happen, without writing anything. */
  async function check(ctx: Ctx, item: any): Promise<{ outcome: 'created' | 'updated' | 'failed'; result: Result }> {
    const ext = typeof item?.external_id === 'string' ? item.external_id : null
    const ref = ext ? await partners.getTourRef(ctx.partner.id, ctx.mode, { externalId: ext }) : null
    const state = ref ? await listings.getState(ref.id) : null
    if (state) {
      const { external_id, vertical, ...rest } = item
      const own = checkPatchOwnership(rest, 'api')
      if (!own.ok) return { outcome: 'failed', result: fail(own.status, own.code, own.message) }
      const p = listingPatchSchema.safeParse(rest)
      if (!p.success) return { outcome: 'failed', result: fail(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { fields: zodFields(p.error) }) }
      const m = mergePatch(toInput(state.listing), p.data)
      if (!m.ok) return { outcome: 'failed', result: fail(400, 'VALIDATION_ERROR', 'The listing would not be valid after this change.', { fields: zodFields(m.error) }) }
      return { outcome: 'updated', result: { status: 200, body: {} } }
    }
    const p = listingInputSchema.safeParse(item)
    if (!p.success) return { outcome: 'failed', result: fail(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', { fields: zodFields(p.error) }) }
    if (!p.data.agent_external_id || !(await partners.getAgent(ctx.partner.id, ctx.mode, p.data.agent_external_id))) {
      return { outcome: 'failed', result: fail(404, 'AGENT_NOT_FOUND', 'No agent with this agent_external_id. Create it with POST /v1/agents first.') }
    }
    return { outcome: 'created', result: { status: 201, body: {} } }
  }

  // ── read ──
  async function get(ctx: Ctx, rawId: string): Promise<Result> {
    const found = await resolve(ctx, rawId)
    if (!found?.state) return notFound()
    return { status: 200, body: { listing: await outOne(found.ref, found.state) } }
  }

  // ── archive / restore ──
  async function archive(ctx: Ctx, rawId: string, opts: { reason?: string; confirmBulk?: boolean } = {}): Promise<Result> {
    const found = await resolve(ctx, rawId)
    if (!found?.state) return notFound()
    const { ref, state, agent } = found
    if (state.publication_status === 'archived') return { status: 200, body: { listing: await outOne(ref, state) } }
    if (!opts.confirmBulk) {
      const rule = LISTING_RULES.bulkDeleteHold
      const [active, recent] = await Promise.all([
        listings.countActive(ctx.partner.id, ctx.mode),
        listings.countRecentArchives(ctx.partner.id, ctx.mode, iso(now() - rule.windowMs)),
      ])
      if (active >= rule.minActive && (recent + 1) > active * rule.maxShare) {
        return fail(409, 'BULK_DELETE_HELD', `More than ${rule.maxShare * 100}% of your active listings were removed in the last hour. If this is intended, send the request again with "confirm_bulk_delete": true in the body; otherwise check your export.`)
      }
    }
    const [space] = await partners.getSpaces([ref.space_id])
    if (space?.is_published) {
      const r = await tours.setPublished(agent.user_id, ref.space_id, false)
      if (!r.ok) return fail(r.status, r.code, r.message)
    }
    const at = iso()
    const restoreUntil = iso(now() + LISTING_RULES.restoreDays * 86400_000)
    const l = toInput(state.listing)
    const res = await listings.commit(ref.id, state.version, {
      publication_status: 'archived', archived_at: at, restore_until: restoreUntil, expires_at: null, pending_listing: null, moderation_reasons: [],
    }, {
      actor_type: ctx.actor.type, actor_id: ctx.actor.id, request_id: ctx.actor.requestId ?? null, action: 'listing.archived',
      changes: { publication_status: [state.publication_status, 'archived'], ...(opts.reason ? { reason: [null, opts.reason.slice(0, 200)] } : {}) },
    }, [eventFor('listing.archived', ref, state.version + 1, 'archived', l)])
    if (!res.ok) return fail(409, 'VERSION_CONFLICT', 'The listing changed while this request was running. Retry.')
    const saved = await listings.getState(ref.id)
    return { status: 200, body: { listing: await outOne(ref, saved!) } }
  }

  async function restore(ctx: Ctx, rawId: string): Promise<Result> {
    const found = await resolve(ctx, rawId)
    if (!found?.state) return notFound()
    const { ref, state, agent } = found
    if (state.publication_status !== 'archived') return fail(409, 'LISTING_NOT_ARCHIVED', 'This listing is not archived.')
    if (state.restore_until && Date.parse(state.restore_until) < now()) {
      return fail(410, 'RESTORE_WINDOW_PASSED', `Archived listings can be restored for ${LISTING_RULES.restoreDays} days. Create it again with POST /v1/listings.`)
    }
    if (ctx.mode === 'live') {
      const limit = ctx.partner.max_live_listings ?? LISTING_RULES.defaultLiveListingLimit
      if ((await listings.countActive(ctx.partner.id, 'live')) >= limit) return fail(403, 'LISTING_LIMIT_REACHED', `Your agreement includes ${limit} live listings.`, { limit })
    }
    const l = toInput(state.listing)
    const tourErr = await pushTour(agent, ref, l, null)
    if (tourErr) return tourErr
    return persist(ctx, { ref, agent, prev: state, listing: l, action: 'listing.restored', events: ['listing.restored'] })
  }

  // ── background and staff ──
  async function loadForSystem(refId: string) {
    const state = await listings.getState(refId)
    if (!state) return null
    const partner = await partners.getPartner(state.partner_id)
    const ref = partner ? await partners.getTourRef(state.partner_id, state.mode, { id: refId }) : null
    const agent = ref ? (await partners.getAgentsByIds([ref.agent_id]))[0] : undefined
    if (!partner || !ref || !agent) return null
    return { state, partner, ref, agent }
  }

  /** After media finishes: a listing waiting for photos may now go live (or to review). */
  async function reevaluate(refId: string): Promise<void> {
    const x = await loadForSystem(refId)
    if (!x || x.state.publication_status !== 'submitted') return
    // Still fetching: nothing to decide yet (avoids a new version on every check).
    const { pending } = await mediaState(x.ref)
    if (pending > 0) return
    const ctx: Ctx = { partner: x.partner, mode: x.state.mode, actor: { type: 'system', id: 'media-worker' } }
    const r = await persist(ctx, { ref: x.ref, agent: x.agent, prev: x.state, listing: toInput(x.state.listing), action: 'listing.updated', events: [] })
    if (r.status >= 400) deps.log?.warn({ refId, error: r.body?.error }, 'partner listing re-evaluation failed')
  }

  async function approve(refId: string, staffId: string): Promise<Result> {
    const x = await loadForSystem(refId)
    if (!x) return notFound()
    if (x.state.publication_status !== 'pending_moderation') return fail(409, 'NOT_PENDING', 'This listing is not waiting for review.')
    const ctx: Ctx = { partner: x.partner, mode: x.state.mode, actor: { type: 'staff', id: staffId } }
    const target = toInput(x.state.pending_listing ?? x.state.listing)
    if (x.state.pending_listing) {
      const e = await pushTour(x.agent, x.ref, target, toInput(x.state.listing))
      if (e) return e
    }
    return persist(ctx, { ref: x.ref, agent: x.agent, prev: { ...x.state, pending_listing: null }, listing: target, action: 'listing.approved', events: [], reviewedBy: staffId, skipReview: true })
  }

  async function reject(refId: string, staffId: string, reasons: Reason[]): Promise<Result> {
    const x = await loadForSystem(refId)
    if (!x) return notFound()
    if (!['pending_moderation', 'published'].includes(x.state.publication_status)) return fail(409, 'NOT_REVIEWABLE', 'Only listings waiting for review or live listings can be rejected.')
    const [space] = await partners.getSpaces([x.ref.space_id])
    if (space?.is_published) await tours.setPublished(x.agent.user_id, x.ref.space_id, false)
    const tagged = reasons.map(r => ({ ...r, by: 'moderator' as const }))
    const l = toInput(x.state.listing)
    const res = await listings.commit(refId, x.state.version, {
      // reviewed_at stays as it was: it records approvals only.
      publication_status: 'rejected', moderation_reasons: tagged, pending_listing: null, expires_at: null, reviewed_by: staffId,
    }, {
      actor_type: 'staff', actor_id: staffId, action: 'listing.rejected',
      changes: { publication_status: [x.state.publication_status, 'rejected'], reasons: [null, tagged.map(r => r.code)] },
    }, [eventFor('listing.rejected', x.ref, x.state.version + 1, 'rejected', l, tagged)])
    if (!res.ok) return fail(409, 'VERSION_CONFLICT', 'The listing changed meanwhile. Reload and try again.')
    return { status: 200, body: { ok: true } }
  }

  async function expire(state: StateRow): Promise<void> {
    const x = await loadForSystem(state.tour_ref_id)
    if (!x || x.state.publication_status !== 'published') return
    const [space] = await partners.getSpaces([x.ref.space_id])
    if (space?.is_published) await tours.setPublished(x.agent.user_id, x.ref.space_id, false)
    const l = toInput(x.state.listing)
    await listings.commit(x.ref.id, x.state.version, { publication_status: 'expired', expires_at: null }, {
      actor_type: 'system', actor_id: 'expiry', action: 'listing.expired', changes: { publication_status: ['published', 'expired'] },
    }, [eventFor('listing.expired', x.ref, x.state.version + 1, 'expired', l, [{
      code: 'NOT_CONFIRMED', message: `No update for ${LISTING_RULES.expiryDays[l.transaction] ?? 90} days. Send the listing again (an unchanged PATCH is enough) to put it back.`, by: 'system',
    }])])
  }

  return { create, patch, upsert, check, get, archive, restore, reevaluate, approve, reject, expire, resolve, out, outOne, outMany }
}

export type ListingService = ReturnType<typeof listingService>
