// Delivering a finished tour into the client's account (Phase 5, migration
// 010). Staff build the tour in the studio account (QUOTE_STUDIO_USER_ID),
// then send the client a single-use link. Only when the client accepts it,
// signed in, does properties.user_id move, in one database transaction that
// also recounts both accounts' usage. An admin can undo it.
//
// Nothing else about the tour changes: scenes and media hang off the
// property, and stored files keep their keys.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'

export type DeliveryStatus = 'pending' | 'accepted' | 'revoked' | 'undone'

export interface Delivery {
  id: string
  jobId: string
  propertyId: string
  propertyTitle: string | null
  fromUserId: string
  toUserId: string | null
  status: DeliveryStatus
  expiresAt: string
  createdBy: string | null
  createdAt: string
  acceptedAt: string | null
  undoneAt: string | null
}

export interface StudioTour { id: string; title: string | null; slug: string | null; coverUrl: string | null; isPublished: boolean; updatedAt: string }

export type AcceptResult = 'ok' | 'not_pending' | 'expired' | 'owner_changed'
export type UndoResult = 'ok' | 'not_accepted' | 'owner_changed'

export interface DeliveryStore {
  // Tours in the studio account, newest first, to pick from on the job page
  studioTours(studioUserId: string, q: string | undefined, limit: number): Promise<StudioTour[]>
  tour(propertyId: string): Promise<(StudioTour & { userId: string }) | null>
  // Revokes any open link for the same tour first
  create(d: { jobId: string; propertyId: string; fromUserId: string; expiresAt: string; createdBy: string }, tokenHash: string): Promise<Delivery>
  forJob(jobId: string): Promise<Delivery[]>
  byToken(tokenHash: string): Promise<Delivery | null>
  get(id: string): Promise<Delivery | null>
  revoke(id: string, actorId: string): Promise<boolean>
  accept(id: string, toUserId: string): Promise<AcceptResult>
  undo(id: string, actorId: string, reason: string): Promise<UndoResult>
}

export interface MemoryTour extends StudioTour { userId: string; storageBytes: number }
export interface MemoryDeliveries {
  tours: MemoryTour[]                         // what the properties table would hold
  rows: Array<Omit<Delivery, 'propertyTitle'> & { tokenHash: string; undoneBy: string | null }>
  usage: Record<string, { activeProperties: number; storageBytes: number }>
}

export function deliveryStoreFor(store: object, db: SupabaseClient): DeliveryStore {
  const dump = (store as { dump?: () => MemoryData }).dump
  return dump ? memoryDeliveryStore(dump) : supabaseDeliveryStore(db)
}

const publicTour = ({ userId: _u, storageBytes: _s, ...t }: MemoryTour): StudioTour => t

export function memoryDeliveryStore(data: () => MemoryData): DeliveryStore {
  const d = () => data().deliveries
  const now = () => data().clock().toISOString()
  const view = (r: MemoryDeliveries['rows'][number]): Delivery => {
    const { tokenHash: _t, undoneBy: _u, ...rest } = r
    return { ...rest, propertyTitle: d().tours.find(t => t.id === r.propertyId)?.title ?? null }
  }
  const recount = (userId: string) => {
    const mine = d().tours.filter(t => t.userId === userId)
    d().usage[userId] = { activeProperties: mine.filter(t => t.isPublished).length, storageBytes: mine.reduce((s, t) => s + t.storageBytes, 0) }
  }
  const audit = (actorId: string | null, jobId: string, action: string, before: unknown, after: unknown, reason: string | null) =>
    data().audit.push({ id: data().audit.length + 1, actorId, entityType: 'job', entityId: jobId, action, before, after, reason, createdAt: now() } as any)
  return {
    async studioTours(studioUserId, q, limit) {
      const needle = q?.toLowerCase()
      return d().tours
        .filter(t => t.userId === studioUserId && (!needle || (t.title ?? '').toLowerCase().includes(needle)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(publicTour)
    },
    async tour(propertyId) {
      const t = d().tours.find(x => x.id === propertyId)
      return t ? { ...publicTour(t), userId: t.userId } : null
    },
    async create(input, tokenHash) {
      for (const r of d().rows) if (r.propertyId === input.propertyId && r.status === 'pending') r.status = 'revoked'
      const row = {
        id: randomUUID(), ...input, toUserId: null, status: 'pending' as const, tokenHash,
        createdAt: now(), acceptedAt: null, undoneAt: null, undoneBy: null,
      }
      d().rows.push(row)
      return view(row)
    },
    async forJob(jobId) {
      return d().rows.filter(r => r.jobId === jobId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view)
    },
    async byToken(tokenHash) {
      const r = d().rows.find(x => x.tokenHash === tokenHash)
      return r ? view(r) : null
    },
    async get(id) {
      const r = d().rows.find(x => x.id === id)
      return r ? view(r) : null
    },
    async revoke(id) {
      const r = d().rows.find(x => x.id === id && x.status === 'pending')
      if (!r) return false
      r.status = 'revoked'
      return true
    },
    async accept(id, toUserId) {
      const r = d().rows.find(x => x.id === id)
      if (!r || r.status !== 'pending') return 'not_pending'
      if (r.expiresAt < now()) return 'expired'
      const t = d().tours.find(x => x.id === r.propertyId && x.userId === r.fromUserId)
      if (!t) return 'owner_changed'
      t.userId = toUserId
      Object.assign(r, { status: 'accepted', toUserId, acceptedAt: now() })
      recount(r.fromUserId)
      recount(toUserId)
      audit(null, r.jobId, 'tour_delivered', { propertyId: r.propertyId, userId: r.fromUserId }, { propertyId: r.propertyId, userId: toUserId }, null)
      return 'ok'
    },
    async undo(id, actorId, reason) {
      const r = d().rows.find(x => x.id === id)
      if (!r || r.status !== 'accepted') return 'not_accepted'
      const t = d().tours.find(x => x.id === r.propertyId && x.userId === r.toUserId)
      if (!t) return 'owner_changed'
      t.userId = r.fromUserId
      Object.assign(r, { status: 'undone', undoneAt: now(), undoneBy: actorId })
      recount(r.fromUserId)
      recount(r.toUserId!)
      audit(actorId, r.jobId, 'tour_delivery_undone', { propertyId: r.propertyId, userId: r.toUserId }, { propertyId: r.propertyId, userId: r.fromUserId }, reason)
      return 'ok'
    },
  }
}

const COLUMNS = 'id, job_id, property_id, from_user_id, to_user_id, status, expires_at, created_by, created_at, accepted_at, undone_at, properties ( title )'
const fromRow = (r: any): Delivery => ({
  id: r.id, jobId: r.job_id, propertyId: r.property_id, propertyTitle: r.properties?.title ?? null,
  fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, expiresAt: r.expires_at,
  createdBy: r.created_by, createdAt: r.created_at, acceptedAt: r.accepted_at, undoneAt: r.undone_at,
})
const tourRow = (r: any): StudioTour => ({
  id: r.id, title: r.title, slug: r.slug, coverUrl: r.cover_image_url, isPublished: !!r.is_published, updatedAt: r.updated_at,
})

export function supabaseDeliveryStore(db: SupabaseClient): DeliveryStore {
  const one = async (query: PromiseLike<{ data: any; error: any }>) => {
    const { data, error } = await query
    if (error) throw error
    return data ? fromRow(data) : null
  }
  return {
    async studioTours(studioUserId, q, limit) {
      let query = db.from('properties').select('id, title, slug, cover_image_url, is_published, updated_at')
        .eq('user_id', studioUserId).order('updated_at', { ascending: false }).limit(limit)
      // Title search: the value is matched literally (% and _ are escaped)
      if (q) query = query.ilike('title', `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`)
      const { data, error } = await query
      if (error) throw error
      return (data ?? []).map(tourRow)
    },
    async tour(propertyId) {
      const { data, error } = await db.from('properties').select('id, user_id, title, slug, cover_image_url, is_published, updated_at').eq('id', propertyId).maybeSingle()
      if (error) throw error
      return data ? { ...tourRow(data), userId: data.user_id } : null
    },
    async create(input, tokenHash) {
      const { error: revokeError } = await db.from('qe_deliveries').update({ status: 'revoked' }).eq('property_id', input.propertyId).eq('status', 'pending')
      if (revokeError) throw revokeError
      return (await one(db.from('qe_deliveries').insert({
        job_id: input.jobId, property_id: input.propertyId, from_user_id: input.fromUserId,
        expires_at: input.expiresAt, created_by: input.createdBy, token_hash: tokenHash,
      }).select(COLUMNS).single()))!
    },
    async forJob(jobId) {
      const { data, error } = await db.from('qe_deliveries').select(COLUMNS).eq('job_id', jobId).order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(fromRow)
    },
    async byToken(tokenHash) {
      return one(db.from('qe_deliveries').select(COLUMNS).eq('token_hash', tokenHash).maybeSingle())
    },
    async get(id) {
      return one(db.from('qe_deliveries').select(COLUMNS).eq('id', id).maybeSingle())
    },
    async revoke(id) {
      const { data, error } = await db.from('qe_deliveries').update({ status: 'revoked' }).eq('id', id).eq('status', 'pending').select('id')
      if (error) throw error
      return (data ?? []).length > 0
    },
    async accept(id, toUserId) {
      const { data, error } = await db.rpc('qe_delivery_accept', { p_id: id, p_user: toUserId })
      if (error) throw error
      return data as AcceptResult
    },
    async undo(id, actorId, reason) {
      const { data, error } = await db.rpc('qe_delivery_undo', { p_id: id, p_actor: actorId, p_reason: reason })
      if (error) throw error
      return data as UndoResult
    },
  }
}
