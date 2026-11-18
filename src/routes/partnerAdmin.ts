import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAdmin, auditLog } from './admin.js'
import { generatePartnerKey } from '../utils/partnerKeys.js'
import { parseWithSchema } from '../utils/validation.js'
import { syncPartnerAgents } from '../partners/billing.js'

// Staff-only: create partner apps, issue and revoke their API keys, and set
// the sites allowed to embed their tours. Same ADMIN_SECRET guard and audit
// log as the rest of /admin.

const SLUG = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, '3–40 lowercase letters, numbers or dashes')
// An origin only: scheme + host (+ port). No path, no wildcard.
const ORIGIN = z.string().trim().max(200).regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?$|^http:\/\/localhost(:\d{2,5})?$/i, 'Use an origin like https://cars.example.co.ke')

const createPartnerBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: SLUG,
  contact_email: z.string().trim().email().max(255).optional(),
  allowed_embed_origins: z.array(ORIGIN).max(20).default([]),
  daily_upload_cap: z.number().int().min(0).max(1_000_000).optional(),
  agent_plan_id: z.string().trim().min(1).max(64).nullable().optional(),
  paid_until: z.string().datetime({ offset: true }).nullable().optional(),
  max_agents: z.number().int().min(0).max(100_000).nullable().optional(),
})

const updatePartnerBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  contact_email: z.string().trim().email().max(255).nullable().optional(),
  allowed_embed_origins: z.array(ORIGIN).max(20).optional(),
  daily_upload_cap: z.number().int().min(0).max(1_000_000).optional(),
  agent_plan_id: z.string().trim().min(1).max(64).nullable().optional(),
  paid_until: z.string().datetime({ offset: true }).nullable().optional(),
  max_agents: z.number().int().min(0).max(100_000).nullable().optional(),
}).refine(b => Object.keys(b).length > 0, 'Nothing to update')

const createKeyBody = z.object({
  mode: z.enum(['test', 'live']),
  label: z.string().trim().max(80).optional(),
})

const idParams = z.object({ id: z.string().uuid() })
const keyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() })

const PARTNER_COLS = 'id, name, slug, status, contact_email, allowed_embed_origins, daily_upload_cap, agent_plan_id, paid_until, max_agents, created_at, updated_at'
const KEY_COLS = 'id, mode, label, key_prefix, created_at, last_used_at, revoked_at'

export default async function partnerAdmin(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request, reply) => {
    await requireAdmin(fastify, request, reply)
  })

  // Drop cached key lookups for a partner so suspensions and revocations
  // take effect at once instead of within the 60 s cache window.
  async function bustKeyCache(partnerId: string) {
    const redis = (fastify as any).redis
    if (!redis) return
    const { data } = await fastify.supabase.from('api_partner_keys').select('key_hash').eq('partner_id', partnerId)
    await Promise.all((data ?? []).map((k: any) => redis.del(`partnerkey:${k.key_hash}`).catch(() => {})))
  }

  async function planExists(planId: string | null | undefined) {
    if (!planId) return true
    const { data } = await fastify.supabase.from('plans').select('id').eq('id', planId).maybeSingle()
    return Boolean(data)
  }

  fastify.get('/', async (_request, reply) => {
    const { data, error } = await fastify.supabase
      .from('api_partners')
      .select(`${PARTNER_COLS}, api_partner_keys(id, revoked_at), api_partner_agents(count), api_partner_tours(count)`)
      .order('created_at', { ascending: false })
    if (error) return reply.code(500).send({ statusMessage: 'Failed to load partners' })
    return reply.send({
      partners: (data ?? []).map((p: any) => ({
        ...p,
        active_keys: (p.api_partner_keys ?? []).filter((k: any) => !k.revoked_at).length,
        agents: p.api_partner_agents?.[0]?.count ?? 0,
        tours: p.api_partner_tours?.[0]?.count ?? 0,
        api_partner_keys: undefined,
        api_partner_agents: undefined,
        api_partner_tours: undefined,
      })),
    })
  })

  fastify.post('/', async (request, reply) => {
    const body = parseWithSchema(reply, createPartnerBody, request.body)
    if (!body) return
    if (!(await planExists(body.agent_plan_id))) return reply.code(400).send({ statusMessage: 'agent_plan_id is not a known plan.' })
    const { data, error } = await fastify.supabase.from('api_partners').insert(body).select(PARTNER_COLS).single()
    if (error?.code === '23505') return reply.code(409).send({ statusMessage: 'That slug is already taken.' })
    if (error) return reply.code(500).send({ statusMessage: 'Failed to create partner' })
    await auditLog(fastify, request, 'partner.create', 'api_partner', data.id, { slug: data.slug })
    return reply.code(201).send({ partner: data })
  })

  fastify.patch('/:id', async (request, reply) => {
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    const body = parseWithSchema(reply, updatePartnerBody, request.body)
    if (!body) return
    if (!(await planExists(body.agent_plan_id))) return reply.code(400).send({ statusMessage: 'agent_plan_id is not a known plan.' })
    const { data, error } = await fastify.supabase.from('api_partners')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.id).select(PARTNER_COLS).maybeSingle()
    if (error) return reply.code(500).send({ statusMessage: 'Failed to update partner' })
    if (!data) return reply.code(404).send({ statusMessage: 'Partner not found' })
    await bustKeyCache(params.id)
    await auditLog(fastify, request, 'partner.update', 'api_partner', params.id, body)
    // Embed sites changed: drop cached embed policies for this partner's tours.
    if (body.allowed_embed_origins !== undefined && (fastify as any).redis) {
      const { data: tours } = await fastify.supabase.from('api_partner_tours')
        .select('properties(slug)').eq('partner_id', params.id)
      await Promise.all((tours ?? []).map((t: any) => t.properties?.slug
        ? (fastify as any).redis.del(`embedpolicy:${t.properties.slug}`).catch(() => {}) : null))
    }
    // Plan or payment changed: move every agent onto it now.
    const billingChanged = body.agent_plan_id !== undefined || body.paid_until !== undefined
    const agents = billingChanged ? await syncPartnerAgents(fastify, params.id) : undefined
    return reply.send({ partner: data, agents_synced: agents })
  })

  // Re-apply the partner's plan to all its agents (e.g. after a failed sync).
  fastify.post('/:id/sync-agents', async (request, reply) => {
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    try {
      const agents = await syncPartnerAgents(fastify, params.id)
      await auditLog(fastify, request, 'partner.sync_agents', 'api_partner', params.id, agents)
      return reply.send({ agents_synced: agents })
    } catch {
      return reply.code(404).send({ statusMessage: 'Partner not found' })
    }
  })

  // Agents and their tour counts, for the admin page.
  fastify.get('/:id/agents', async (request, reply) => {
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    const { data, error } = await fastify.supabase.from('api_partner_agents')
      .select('id, mode, external_id, name, user_id, created_at, api_partner_tours(count)')
      .eq('partner_id', params.id).order('created_at', { ascending: false }).limit(500)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to load agents' })
    return reply.send({
      agents: (data ?? []).map((a: any) => ({ ...a, tours: a.api_partner_tours?.[0]?.count ?? 0, api_partner_tours: undefined })),
    })
  })

  fastify.get('/:id/keys', async (request, reply) => {
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    const { data, error } = await fastify.supabase.from('api_partner_keys').select(KEY_COLS)
      .eq('partner_id', params.id).order('created_at', { ascending: false })
    if (error) return reply.code(500).send({ statusMessage: 'Failed to load keys' })
    return reply.send({ keys: data ?? [] })
  })

  // The full key is returned once, here, and never stored.
  fastify.post('/:id/keys', async (request, reply) => {
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    const body = parseWithSchema(reply, createKeyBody, request.body)
    if (!body) return
    const { data: partner } = await fastify.supabase.from('api_partners').select('id').eq('id', params.id).maybeSingle()
    if (!partner) return reply.code(404).send({ statusMessage: 'Partner not found' })

    const { key, prefix, hash } = generatePartnerKey(body.mode)
    const { data, error } = await fastify.supabase.from('api_partner_keys')
      .insert({ partner_id: params.id, mode: body.mode, label: body.label ?? null, key_prefix: prefix, key_hash: hash })
      .select(KEY_COLS).single()
    if (error) return reply.code(500).send({ statusMessage: 'Failed to create key' })
    await auditLog(fastify, request, 'partner.key.create', 'api_partner', params.id, { keyId: data.id, mode: body.mode })
    return reply.code(201).send({ key: { ...data, secret: key }, note: 'Copy this key now. It will not be shown again.' })
  })

  fastify.delete('/:id/keys/:keyId', async (request, reply) => {
    const params = parseWithSchema(reply, keyParams, request.params)
    if (!params) return
    const { data, error } = await fastify.supabase.from('api_partner_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', params.keyId).eq('partner_id', params.id).is('revoked_at', null)
      .select('id, key_hash').maybeSingle()
    if (error) return reply.code(500).send({ statusMessage: 'Failed to revoke key' })
    if (!data) return reply.code(404).send({ statusMessage: 'Key not found or already revoked' })
    const redis = (fastify as any).redis
    if (redis) await redis.del(`partnerkey:${data.key_hash}`).catch(() => {})
    await auditLog(fastify, request, 'partner.key.revoke', 'api_partner', params.id, { keyId: params.keyId })
    return reply.code(204).send()
  })
}
