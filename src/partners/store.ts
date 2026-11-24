import type { FastifyInstance } from 'fastify'
import type { KeyMode } from '../utils/partnerKeys.js'
import { syncAgentSubscription } from './billing.js'

// Every database read/write the partner API makes, behind one interface so
// the routes can be tested without Supabase.

export type Partner = {
  id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
  allowed_embed_origins: string[]
  daily_upload_cap: number
  agent_plan_id: string | null
  paid_until: string | null
  max_agents: number | null
  /** Migration 004; undefined before it runs (the default of 2,000 applies). */
  max_live_listings?: number
}

export type KeyRecord = {
  keyId: string
  mode: KeyMode
  revoked: boolean
  partner: Partner
  /** Migration 004. NULL = a key from before scopes (see partners/scopes.ts). */
  scopes?: string[] | null
  expiresAt?: string | null
}

export type AgentRow = {
  id: string
  partner_id: string
  mode: KeyMode
  external_id: string
  user_id: string
  name: string | null
  created_at: string
}

export type TourRefRow = {
  id: string
  partner_id: string
  mode: KeyMode
  external_id: string
  space_id: string
  agent_id: string
  created_at: string
}

export type SpaceSummary = {
  id: string
  title: string
  slug: string | null
  property_type: string
  is_published: boolean
  cover_image_url: string | null
  has_360: boolean | null
  has_gallery: boolean | null
  created_at: string
  updated_at: string
  /** The Viewora account that owns the tour. */
  user_id?: string
}

export type CreateUserResult = { userId: string } | { error: 'email_in_use' | 'failed' }

export interface PartnerStore {
  findKeyByHash(hash: string): Promise<KeyRecord | null>
  touchKey(keyId: string): Promise<void>

  getAgent(partnerId: string, mode: KeyMode, externalId: string): Promise<AgentRow | null>
  getAgentsByIds(ids: string[]): Promise<AgentRow[]>
  listAgents(partnerId: string, mode: KeyMode, limit: number, offset: number): Promise<AgentRow[]>
  countAgents(partnerId: string, mode: KeyMode): Promise<number>
  /** Puts the agent on the partner's paid plan (see partners/billing.ts). */
  syncAgentPlan(partner: Partner, userId: string): Promise<void>
  /** 'duplicate' when (partner, mode, external_id) already exists. */
  insertAgent(row: Omit<AgentRow, 'id' | 'created_at'>): Promise<AgentRow | 'duplicate'>
  createAuthUser(input: { email: string; name: string | null; partnerSlug: string }): Promise<CreateUserResult>
  deleteAuthUser(userId: string): Promise<void>

  getPartner(id: string): Promise<Partner | null>
  getTourRef(partnerId: string, mode: KeyMode, by: { id?: string; spaceId?: string; externalId?: string }): Promise<TourRefRow | null>
  listTourRefs(partnerId: string, mode: KeyMode, opts: { agentId?: string; limit: number; offset: number }): Promise<TourRefRow[]>
  insertTourRef(row: Omit<TourRefRow, 'id' | 'created_at'>): Promise<TourRefRow | 'duplicate'>
  deleteTourRef(id: string): Promise<void>
  /** Gives the tour to another agent's account and points the reference at that agent. False if the tour was not where expected. */
  moveTour(ref: { id: string; space_id: string }, from: { agentId: string; userId: string }, to: { agentId: string; userId: string }): Promise<boolean>
  getSpaces(ids: string[]): Promise<SpaceSummary[]>

  /** Has this exact uploaded file already been turned into a scene / car photo? (retry safety) */
  sceneExists(spaceId: string, rawImageUrl: string): Promise<boolean>
  vehicleViewExists(spaceId: string, imageUrl: string): Promise<boolean>
}

const PARTNER_COLS = 'id, slug, name, status, allowed_embed_origins, daily_upload_cap, agent_plan_id, paid_until, max_agents'
const AGENT_COLS = 'id, partner_id, mode, external_id, user_id, name, created_at'
const TOUR_COLS = 'id, partner_id, mode, external_id, space_id, agent_id, created_at'
const SPACE_COLS = 'id, title, slug, property_type, is_published, cover_image_url, has_360, has_gallery, created_at, updated_at, user_id'

export function supabaseStore(fastify: FastifyInstance): PartnerStore {
  const db = fastify.supabase

  return {
    async findKeyByHash(hash) {
      // Migration 004 adds scopes, expiry and the listing limit. Until it
      // runs, fall back to the columns 001/002 have so /v1 keeps working.
      const lookup = (withScopes: boolean) => db
        .from('api_partner_keys')
        .select(withScopes
          ? `id, mode, revoked_at, scopes, expires_at, api_partners(${PARTNER_COLS}, max_live_listings)`
          : `id, mode, revoked_at, api_partners(${PARTNER_COLS})`)
        .eq('key_hash', hash)
        .maybeSingle()
      let { data, error } = await lookup(true)
      if (error && /scopes|expires_at|max_live_listings/.test(error.message)) ({ data, error } = await lookup(false))
      if (error) throw new Error(`partner key lookup failed: ${error.message}`)
      if (!data || !(data as any).api_partners) return null
      const d = data as any
      return {
        keyId: d.id,
        mode: d.mode,
        revoked: Boolean(d.revoked_at),
        partner: d.api_partners as Partner,
        scopes: d.scopes ?? null,
        expiresAt: d.expires_at ?? null,
      }
    },

    async getPartner(id) {
      let { data, error } = await db.from('api_partners').select(`${PARTNER_COLS}, max_live_listings`).eq('id', id).maybeSingle()
      if (error && /max_live_listings/.test(error.message)) ({ data, error } = await db.from('api_partners').select(PARTNER_COLS).eq('id', id).maybeSingle())
      if (error) throw new Error(error.message)
      return (data as Partner) ?? null
    },

    async touchKey(keyId) {
      await db.from('api_partner_keys').update({ last_used_at: new Date().toISOString() }).eq('id', keyId)
    },

    async getAgent(partnerId, mode, externalId) {
      const { data, error } = await db.from('api_partner_agents').select(AGENT_COLS)
        .eq('partner_id', partnerId).eq('mode', mode).eq('external_id', externalId).maybeSingle()
      if (error) throw new Error(error.message)
      return (data as AgentRow) ?? null
    },

    async getAgentsByIds(ids) {
      if (!ids.length) return []
      const { data, error } = await db.from('api_partner_agents').select(AGENT_COLS).in('id', ids)
      if (error) throw new Error(error.message)
      return (data ?? []) as AgentRow[]
    },

    async listAgents(partnerId, mode, limit, offset) {
      const { data, error } = await db.from('api_partner_agents').select(AGENT_COLS)
        .eq('partner_id', partnerId).eq('mode', mode)
        .order('created_at', { ascending: false }).range(offset, offset + limit - 1)
      if (error) throw new Error(error.message)
      return (data ?? []) as AgentRow[]
    },

    async countAgents(partnerId, mode) {
      const { count, error } = await db.from('api_partner_agents').select('id', { count: 'exact', head: true })
        .eq('partner_id', partnerId).eq('mode', mode)
      if (error) throw new Error(error.message)
      return count ?? 0
    },

    async syncAgentPlan(partner, userId) {
      await syncAgentSubscription(fastify, partner, userId)
    },

    async insertAgent(row) {
      const { data, error } = await db.from('api_partner_agents').insert(row).select(AGENT_COLS).single()
      if (error?.code === '23505') return 'duplicate'
      if (error) throw new Error(error.message)
      return data as AgentRow
    },

    async createAuthUser({ email, name, partnerSlug }) {
      // admin.createUser sends no email. email_confirm: the address can only
      // be used to sign in by whoever controls it (password reset / magic link).
      const { data, error } = await db.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: name ?? undefined, created_by_partner: partnerSlug },
      })
      if (error) {
        const msg = String(error.message || '').toLowerCase()
        if ((error as any).status === 422 || msg.includes('already') || msg.includes('exists')) return { error: 'email_in_use' }
        fastify.log.error({ err: error.message }, 'partner agent createUser failed')
        return { error: 'failed' }
      }
      return { userId: data.user!.id }
    },

    async deleteAuthUser(userId) {
      await db.auth.admin.deleteUser(userId).catch(() => {})
    },

    async getTourRef(partnerId, mode, by) {
      let q = db.from('api_partner_tours').select(TOUR_COLS).eq('partner_id', partnerId).eq('mode', mode)
      if (by.id) q = q.eq('id', by.id)
      else if (by.spaceId) q = q.eq('space_id', by.spaceId)
      else if (by.externalId) q = q.eq('external_id', by.externalId)
      else return null
      const { data, error } = await q.maybeSingle()
      if (error) throw new Error(error.message)
      return (data as TourRefRow) ?? null
    },

    async listTourRefs(partnerId, mode, { agentId, limit, offset }) {
      let q = db.from('api_partner_tours').select(TOUR_COLS).eq('partner_id', partnerId).eq('mode', mode)
      if (agentId) q = q.eq('agent_id', agentId)
      const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1)
      if (error) throw new Error(error.message)
      return (data ?? []) as TourRefRow[]
    },

    async insertTourRef(row) {
      const { data, error } = await db.from('api_partner_tours').insert(row).select(TOUR_COLS).single()
      if (error?.code === '23505') return 'duplicate'
      if (error) throw new Error(error.message)
      return data as TourRefRow
    },

    async deleteTourRef(id) {
      await db.from('api_partner_tours').delete().eq('id', id)
    },

    async moveTour(ref, from, to) {
      const { data: moved, error } = await db.from('properties').update({ user_id: to.userId })
        .eq('id', ref.space_id).eq('user_id', from.userId).select('id')
      if (error) throw new Error(error.message)
      if (!moved?.length) return false
      const r = await db.from('api_partner_tours').update({ agent_id: to.agentId }).eq('id', ref.id).eq('agent_id', from.agentId)
      if (r.error) {
        // Put the tour back so the reference and the owner never disagree.
        await db.from('properties').update({ user_id: from.userId }).eq('id', ref.space_id)
        throw new Error(r.error.message)
      }
      return true
    },

    async getSpaces(ids) {
      if (!ids.length) return []
      const { data, error } = await db.from('properties').select(SPACE_COLS).in('id', ids)
      if (error) throw new Error(error.message)
      return (data ?? []) as SpaceSummary[]
    },

    async sceneExists(spaceId, rawImageUrl) {
      const { count } = await db.from('scenes').select('id', { count: 'exact', head: true })
        .eq('space_id', spaceId).eq('raw_image_url', rawImageUrl)
      return (count ?? 0) > 0
    },

    async vehicleViewExists(spaceId, imageUrl) {
      const { count } = await db.from('vehicle_views').select('id', { count: 'exact', head: true })
        .eq('space_id', spaceId).eq('image_url', imageUrl)
      return (count ?? 0) > 0
    },
  }
}
