// Links, QR codes and partners (under /admin/quote). The staff check runs in
// quoteAdmin.ts first.
//
//   GET  /links                     DM and campaign links, newest first (?kind=, ?leadId=)
//   POST /links                     make a link; a DM link's address is shown only now
//   POST /links/:id/revoke          stop a link working
//   GET  /leads/:id/attribution     a lead's partner and the DM links made for them
//   GET  /partners                  POST /partners, PATCH /partners/:id (admin)
//   GET  /commission                what each partner is owed (admin)
//   GET  /commission.csv            the same as a spreadsheet (admin)
//   POST /commission/payouts        record commission paid (admin)

import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { allowed } from '../quote/staffAuth.js'
import type { QuoteStore } from '../quote/store.js'
import type { LinkStore } from '../quote/linkStore.js'
import { modules } from '../quote/modules/index.js'
import { PLANNED_INDUSTRIES } from '../quote/industries.js'
import {
  DM_LINK_DAYS, campaignCodeSchema, commissionCsv, commissionFor, linkState, newDmCode, partnerCodeSchema, storedKey,
  type EntryLink, type LinkPrefill,
} from '../quote/links.js'

const id = z.object({ id: z.string().uuid() })
const source = z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/, 'Use a short word like instagram or qr.')
const moduleKey = z.string().refine(k => modules[k]?.enabled, 'Unknown industry').optional()
const industryHint = z.enum(PLANNED_INDUSTRIES).optional()

const dmBody = z.object({
  kind: z.literal('dm'),
  firstName: z.string().trim().min(1).max(60).optional(),
  leadId: z.string().uuid().optional(),
  moduleKey, industryHint, source,
  partnerCode: partnerCodeSchema.optional(),
  days: z.number().int().min(1).max(90).optional(),
})
const campaignBody = z.object({
  kind: z.literal('campaign'),
  code: campaignCodeSchema.optional(),
  label: z.string().trim().min(1).max(80),
  moduleKey, industryHint,
  town: z.string().trim().min(1).max(80).optional(),
  source,
  partnerCode: partnerCodeSchema.optional(),
  expiresAt: z.string().datetime().optional(),
})
const linkBody = z.discriminatedUnion('kind', [dmBody, campaignBody])
const linkQuery = z.object({ kind: z.enum(['dm', 'campaign']).optional(), leadId: z.string().uuid().optional() })

const partnerBody = z.object({
  name: z.string().trim().min(1).max(80),
  code: partnerCodeSchema,
  commissionType: z.enum(['percent', 'fixed']),
  commissionValue: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
}).refine(p => p.commissionType !== 'percent' || p.commissionValue <= 5_000, { message: 'A percentage is at most 50%.', path: ['commissionValue'] })
const partnerPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  code: partnerCodeSchema.optional(),
  commissionType: z.enum(['percent', 'fixed']).optional(),
  commissionValue: z.number().int().min(0).max(100_000_000).optional(),
  active: z.boolean().optional(),
})
const commissionQuery = z.object({ partner: z.string().uuid().optional() })
const payoutBody = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(200),
  reference: z.string().trim().max(80).nullable().optional(),
})

const taken = (e: unknown) => e instanceof Error && e.message === 'qe:code_taken'

export default async function quoteLinkRoutes(fastify: FastifyInstance, opts: {
  links: LinkStore; store: QuoteStore; now: () => Date; publicUrl: string
}) {
  const { links, store, now, publicUrl } = opts
  const linkUrl = (code: string) => `${publicUrl}/q/${code}`
  // Campaign links show their address; a DM link's address only exists in the reply that made it
  const withState = (l: EntryLink) => ({ ...l, state: linkState(l, now()), url: l.code ? linkUrl(l.code) : null })

  fastify.get('/links', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const q = parseWithSchema(reply, linkQuery, request.query)
    if (!q) return
    return { links: (await links.listLinks(q)).map(withState) }
  })

  fastify.post('/links', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const body = parseWithSchema(reply, linkBody, request.body)
    if (!body) return
    const staff = request.quoteStaff!
    if (body.industryHint && body.moduleKey !== 'other') {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [{ field: 'industryHint', message: 'Only for the "other" industry.' }] })
    }
    if (body.partnerCode) {
      const p = await links.partnerByCode(body.partnerCode)
      if (!p?.active) return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [{ field: 'partnerCode', message: 'No active partner has that code.' }] })
    }
    const prefill: LinkPrefill = {
      ...(body.moduleKey ? { moduleKey: body.moduleKey } : {}),
      ...(body.industryHint ? { industryHint: body.industryHint } : {}),
      source: body.source,
      ...(body.partnerCode ? { partnerCode: body.partnerCode } : {}),
    }

    if (body.kind === 'dm') {
      let firstName = body.firstName
      if (body.leadId) {
        const lead = await store.getLead(body.leadId)
        if (!lead) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No lead with that id.' })
        firstName ??= lead.firstName ?? undefined
      }
      if (!firstName) return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [{ field: 'firstName', message: 'Type the name to greet them with.' }] })
      const code = newDmCode()
      const link = await links.createLink({
        kind: 'dm', key: storedKey('dm', code), label: null, prefill: { ...prefill, firstName },
        leadId: body.leadId ?? null, createdBy: staff.id, maxUses: null,
        expiresAt: new Date(now().getTime() + (body.days ?? DM_LINK_DAYS) * 86_400_000).toISOString(),
      })
      return reply.code(201).send({ link: withState(link), url: linkUrl(code) })
    }

    const code = body.code ?? crypto.randomBytes(4).toString('hex')
    try {
      const link = await links.createLink({
        kind: 'campaign', key: storedKey('campaign', code), label: body.label,
        prefill: { ...prefill, ...(body.town ? { town: body.town } : {}) },
        leadId: null, createdBy: staff.id, maxUses: null, expiresAt: body.expiresAt ?? null,
      })
      return reply.code(201).send({ link: withState(link), url: linkUrl(code) })
    } catch (e) {
      if (taken(e)) return reply.code(409).send({ code: 'CODE_TAKEN', fields: [{ field: 'code', message: 'Another link already uses that code.' }] })
      throw e
    }
  })

  fastify.post('/links/:id/revoke', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const link = await links.revokeLink(params.id, request.quoteStaff!.id)
    if (!link) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No link with that id.' })
    return { link: withState(link) }
  })

  fastify.get('/leads/:id/attribution', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const [partner, dm] = await Promise.all([links.leadPartner(params.id), links.listLinks({ leadId: params.id })])
    return { partner, links: dm.map(withState) }
  })

  // ── Partners ───────────────────────────────────────────────────────────
  fastify.get('/partners', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    return { partners: await links.partners(), formUrl: `${publicUrl}/quote` }
  })

  fastify.post('/partners', async (request, reply) => {
    if (!allowed(request, reply, 'partners:write')) return
    const body = parseWithSchema(reply, partnerBody, request.body)
    if (!body) return
    try {
      return reply.code(201).send({ partner: await links.createPartner(body, request.quoteStaff!.id) })
    } catch (e) {
      if (taken(e)) return reply.code(409).send({ code: 'CODE_TAKEN', fields: [{ field: 'code', message: 'Another partner already has that code.' }] })
      throw e
    }
  })

  fastify.patch('/partners/:id', async (request, reply) => {
    if (!allowed(request, reply, 'partners:write')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const body = parseWithSchema(reply, partnerPatch, request.body)
    if (!body) return
    const current = (await links.partners()).find(p => p.id === params.id)
    if (!current) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No partner with that id.' })
    if ((body.commissionType ?? current.commissionType) === 'percent' && (body.commissionValue ?? current.commissionValue) > 5_000) {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [{ field: 'commissionValue', message: 'A percentage is at most 50%.' }] })
    }
    try {
      return { partner: await links.updatePartner(params.id, body, request.quoteStaff!.id) }
    } catch (e) {
      if (taken(e)) return reply.code(409).send({ code: 'CODE_TAKEN', fields: [{ field: 'code', message: 'Another partner already has that code.' }] })
      throw e
    }
  })

  // ── Commission ─────────────────────────────────────────────────────────
  const report = async (partnerId?: string) => (await links.commissionJobs({ partnerId })).map(commissionFor)

  fastify.get('/commission', async (request, reply) => {
    if (!allowed(request, reply, 'commission:read')) return
    const q = parseWithSchema(reply, commissionQuery, request.query)
    if (!q) return
    const rows = await report(q.partner)
    // Totals per currency, never mixed
    const totals: Record<string, { owed: number; paid: number; waiting: number }> = {}
    for (const r of rows) {
      const t = (totals[r.currency] ??= { owed: 0, paid: 0, waiting: 0 })
      if (r.commissionStatus === 'owed') t.owed += r.commission ?? 0
      if (r.commissionStatus === 'paid') t.paid += r.commission ?? 0
      if (r.commissionStatus === 'waiting') t.waiting += r.commission ?? 0
    }
    return { rows, totals }
  })

  fastify.get('/commission.csv', async (request, reply) => {
    if (!allowed(request, reply, 'commission:read')) return
    const q = parseWithSchema(reply, commissionQuery, request.query)
    if (!q) return
    const csv = commissionCsv(await report(q.partner))
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="viewora-commission-${now().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })

  fastify.post('/commission/payouts', async (request, reply) => {
    if (!allowed(request, reply, 'partners:write')) return
    const body = parseWithSchema(reply, payoutBody, request.body)
    if (!body) return
    // Amounts come from the report, not the browser, and only owed jobs are paid
    const owed = new Map((await report()).filter(r => r.commissionStatus === 'owed').map(r => [r.jobId, r.commission!]))
    const notOwed = body.jobIds.filter(j => !owed.has(j))
    if (notOwed.length) {
      return reply.code(409).send({ code: 'NOT_OWED', statusMessage: 'Some of those jobs are not owed commission any more. Refresh and try again.', jobIds: notOwed })
    }
    const recorded = await links.recordPayouts(body.jobIds.map(jobId => ({ jobId, amount: owed.get(jobId)! })), body.reference || null, request.quoteStaff!.id)
    return { recorded }
  })
}
