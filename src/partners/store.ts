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
}

export type KeyRecord = { keyId: string; mode: KeyMode; revoked: boolean; partner: Partner }

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

  getTourRef(partnerId: string, mode: KeyMode, by: { spaceId?: string; externalId?: string }): Promise<TourRefRow | null>
  listTourRefs(partnerId: string, mode: KeyMode, opts: { agentId?: string; limit: number; offset: number }): Promise<TourRefRow[]>
  insertTourRef(row: Omit<TourRefRow, 'id' | 'created_at'>): Promise<TourRefRow | 'duplicate'>
  deleteTourRef(id: string): Promise<void>
  getSpaces(ids: string[]): Promise<SpaceSummary[]>

  /** Has this exact uploaded file already been turned into a scene / car photo? (retry safety) */
  sceneExists(spaceId: string, rawImageUrl: string): Promise<boolean>
  vehicleViewExists(spaceId: string, imageUrl: string): Promise<boolean>
}

const AGENT_COLS = 'id, partner_id, mode, external_id, user_id, name, created_at'
const TOUR_COLS = 'id, partner_id, mode, external_id, space_id, agent_id, created_at'
const SPACE_COLS = 'id, title, slug, property_type, is_published, cover_image_url, has_360, has_gallery, created_at, updated_at'

export function supabaseStore(fastify: FastifyInstance): PartnerStore {
  const db = fastify.supabase

  return {
    async findKeyByHash(hash) {
      const { data, error } = await db
        .from('api_partner_keys')
        .select('id, mode, revoked_at, api_partners(id, slug, name, status, allowed_embed_origins, daily_upload_cap, agent_plan_id, paid_until, max_agents)')
        .eq('key_hash', hash)
        .maybeSingle()
      if (error) throw new Error(`partner key lookup failed: ${error.message}`)
      if (!data || !(data as any).api_partners) return null
      return {
        keyId: data.id,
        mode: data.mode,
        revoked: Boolean(data.revoked_at),
        partner: (data as any).api_partners as Partner,
      }
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
      if (by.spaceId) q = q.eq('space_id', by.spaceId)
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
