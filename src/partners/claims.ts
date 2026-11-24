import { z } from 'zod'
import type { KeyMode } from '../utils/partnerKeys.js'
import type { PartnerStore } from './store.js'
import type { AgentLite, ClaimRow, ListingStore } from './listingStore.js'
import type { Ctx, Result } from './listingService.js'

// Claims: a partner asks to manage a tour that one of its agents made in the
// Viewora app. The agent approves or declines in the app. Approval links the
// tour to the partner's external_id; the partner then sends the listing with
// POST /v1/listings and from then on owns its facts (price, availability).
// Nothing changes on the tour until the agent says yes.

export const CLAIM_RULES = { maxOpenPerPartner: 500, expiryDays: 14 } as const

const EXTERNAL_ID = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:\-]+$/, 'Use letters, numbers, dot, dash, underscore or colon')
export const claimBody = z.object({
  tour_id: z.string().uuid(),
  agent_external_id: EXTERNAL_ID,
  external_id: EXTERNAL_ID,
  note: z.string().trim().max(300).optional(),
}).strict()

const fail = (status: number, code: string, message: string): Result => ({ status, body: { error: { code, message } } })

export type ClaimDeps = { partners: PartnerStore; listings: ListingStore; now?: () => number }

export function claimService(deps: ClaimDeps) {
  const { partners, listings } = deps
  const now = () => (deps.now ? deps.now() : Date.now())
  const iso = (ms = now()) => new Date(ms).toISOString()

  const out = (c: ClaimRow, agentExternalId?: string | null) => ({
    id: `clm_${c.id}`, tour_id: c.space_id, external_id: c.external_id, agent_external_id: agentExternalId ?? null,
    status: c.status, note: c.note, created_at: c.created_at, expires_at: c.expires_at, decided_at: c.decided_at,
  })
  const parseId = (raw: string) => (/^clm_[0-9a-f-]{36}$/i.test(raw) ? raw.slice(4).toLowerCase() : null)

  const event = (type: string, c: ClaimRow, agentExternalId: string | null) => ({
    event_type: type,
    payload: { claim: { id: `clm_${c.id}`, tour_id: c.space_id, external_id: c.external_id, agent_external_id: agentExternalId, status: c.status } },
  })

  async function agentExt(c: ClaimRow) {
    return (await partners.getAgentsByIds([c.agent_id]))[0]?.external_id ?? null
  }

  // ── partner side ──
  async function request(ctx: Ctx, body: unknown): Promise<Result> {
    const p = claimBody.safeParse(body)
    if (!p.success) {
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Some fields are missing or invalid.',
        fields: p.error.issues.map(i => ({ field: i.path.join('.') || 'body', message: i.message })) } } }
    }
    const b = p.data
    const agent = await partners.getAgent(ctx.partner.id, ctx.mode, b.agent_external_id)
    if (!agent) return fail(404, 'AGENT_NOT_FOUND', 'No agent with this agent_external_id.')
    // Only the agent's own tours can be claimed; anything else looks like "not found".
    const [space] = await partners.getSpaces([b.tour_id])
    if (!space || space.user_id !== agent.user_id) return fail(404, 'TOUR_NOT_FOUND', 'This agent has no tour with this id.')
    if (await partners.getTourRef(ctx.partner.id, ctx.mode, { spaceId: b.tour_id })) {
      return fail(409, 'TOUR_ALREADY_LINKED', 'This tour is already one of your listings.')
    }
    if (await partners.getTourRef(ctx.partner.id, ctx.mode, { externalId: b.external_id })) {
      return fail(409, 'LISTING_EXISTS', 'You already have a listing or tour with this external_id.')
    }
    const open = await listings.listClaims({ partnerId: ctx.partner.id, mode: ctx.mode, status: 'pending', limit: CLAIM_RULES.maxOpenPerPartner })
    if (open.length >= CLAIM_RULES.maxOpenPerPartner) return fail(429, 'TOO_MANY_OPEN_CLAIMS', `At most ${CLAIM_RULES.maxOpenPerPartner} claims can wait for agents at once.`)
    const c = await listings.insertClaim({ partner_id: ctx.partner.id, mode: ctx.mode, agent_id: agent.id, space_id: b.tour_id, external_id: b.external_id, note: b.note ?? null })
    if (c === 'duplicate') return fail(409, 'CLAIM_EXISTS', 'A claim for this tour or external_id is already waiting for the agent.')
    await listings.insertAudit({ partner_id: ctx.partner.id, mode: ctx.mode, actor_type: ctx.actor.type, actor_id: ctx.actor.id, request_id: ctx.actor.requestId ?? null,
      action: 'claim.requested', entity_type: 'claim', entity_id: c.id, changes: { tour_id: [null, c.space_id], external_id: [null, c.external_id] } })
    return { status: 201, body: { claim: out(c, agent.external_id) } }
  }

  async function ownClaim(ctx: Ctx, rawId: string) {
    const id = parseId(rawId)
    const c = id ? await listings.getClaim(id) : null
    return c && c.partner_id === ctx.partner.id && c.mode === ctx.mode ? c : null
  }

  async function get(ctx: Ctx, rawId: string): Promise<Result> {
    const c = await ownClaim(ctx, rawId)
    if (!c) return fail(404, 'CLAIM_NOT_FOUND', 'No claim with this id for your account.')
    return { status: 200, body: { claim: out(c, await agentExt(c)) } }
  }

  async function list(ctx: Ctx, status?: ClaimRow['status']): Promise<Result> {
    const rows = await listings.listClaims({ partnerId: ctx.partner.id, mode: ctx.mode, status, limit: 200 })
    const agents = await partners.getAgentsByIds([...new Set(rows.map(r => r.agent_id))])
    const ext = new Map(agents.map(a => [a.id, a.external_id]))
    return { status: 200, body: { data: rows.map(r => out(r, ext.get(r.agent_id))) } }
  }

  async function cancel(ctx: Ctx, rawId: string): Promise<Result> {
    const c = await ownClaim(ctx, rawId)
    if (!c) return fail(404, 'CLAIM_NOT_FOUND', 'No claim with this id for your account.')
    const done = await listings.decideClaim(c.id, 'cancelled', null, iso())
    if (!done) return fail(409, 'CLAIM_NOT_PENDING', `This claim is already ${c.status}.`)
    return { status: 200, body: { claim: out(done, await agentExt(done)) } }
  }

  // ── agent side (signed in to the Viewora app) ──
  async function forUser(userId: string) {
    const agents = await listings.agentsForUser(userId)
    if (!agents.length) return []
    const rows = await listings.listClaims({ agentIds: agents.map(a => a.id), status: 'pending', limit: 100 })
    const spaces = await partners.getSpaces([...new Set(rows.map(r => r.space_id))])
    const byAgent = new Map(agents.map(a => [a.id, a]))
    const title = new Map(spaces.map(s => [s.id, s.title]))
    return rows.filter(r => Date.parse(r.expires_at) > now()).map(r => ({
      id: r.id, partner_name: byAgent.get(r.agent_id)?.partner_name ?? 'A partner', tour_id: r.space_id,
      tour_title: title.get(r.space_id) ?? 'Untitled tour', external_id: r.external_id, note: r.note,
      created_at: r.created_at, expires_at: r.expires_at,
    }))
  }

  async function decide(userId: string, claimId: string, approve: boolean): Promise<Result> {
    const c = await listings.getClaim(claimId)
    const agents: AgentLite[] = c ? await listings.agentsForUser(userId) : []
    const agent = c ? agents.find(a => a.id === c.agent_id) : undefined
    if (!c || !agent) return fail(404, 'CLAIM_NOT_FOUND', 'This request was not found.')
    if (c.status !== 'pending' || Date.parse(c.expires_at) <= now()) return fail(409, 'CLAIM_NOT_PENDING', 'This request has already been answered or has expired.')
    if (approve) {
      const [space] = await partners.getSpaces([c.space_id])
      if (!space || space.user_id !== userId) return fail(409, 'TOUR_MOVED', 'This tour is no longer in your account.')
      const ref = await partners.insertTourRef({ partner_id: c.partner_id, mode: c.mode as KeyMode, external_id: c.external_id, space_id: c.space_id, agent_id: c.agent_id })
      if (ref === 'duplicate') {
        await listings.decideClaim(c.id, 'declined', userId, iso())
        return fail(409, 'ALREADY_LINKED', 'This tour or listing id is already linked. The request was closed.')
      }
    }
    const done = await listings.decideClaim(c.id, approve ? 'approved' : 'declined', userId, iso())
    if (!done) return fail(409, 'CLAIM_NOT_PENDING', 'This request has already been answered.')
    await listings.insertAudit({ partner_id: c.partner_id, mode: c.mode, actor_type: 'user', actor_id: userId, request_id: null,
      action: approve ? 'claim.approved' : 'claim.declined', entity_type: 'claim', entity_id: c.id, changes: { status: ['pending', done.status] } })
    await listings.insertEvents(c.partner_id, c.mode, [event(approve ? 'claim.approved' : 'claim.declined', done, agent.external_id)])
    return { status: 200, body: { ok: true, status: done.status } }
  }

  async function expireDue(): Promise<number> {
    const due = await listings.dueClaimExpiries(iso(), 50)
    for (const c of due) {
      const done = await listings.decideClaim(c.id, 'expired', null, iso())
      if (done) await listings.insertEvents(c.partner_id, c.mode, [event('claim.expired', done, await agentExt(done))])
    }
    return due.length
  }

  return { request, get, list, cancel, forUser, decide, expireDue, parseId }
}

export type ClaimService = ReturnType<typeof claimService>
