// Rate table editor routes (under /admin/quote). Everyone with a staff role
// can read prices and history; only admins can edit a draft, publish it or
// roll back. Publishing never touches sent quotes: each keeps the version
// it was built on. The staff check runs in quoteAdmin.ts.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'
import { DeskError, type DeskStore, type FullRateTable } from '../quote/deskStore.js'
import { allowed } from '../quote/staffAuth.js'
import { modules, validateModule } from '../quote/modules/index.js'
import { diffTables, examplePrices, itemUsage } from '../quote/rates.js'
import { clearRateCache } from '../quote/supabaseStore.js'
import type { RateTable } from '../quote/engine/types.js'

const MESSAGES: Record<string, string> = {
  not_found: 'That rate table or price no longer exists.',
  not_draft: 'Only a draft can be changed. Start a new draft from the published table.',
  draft_exists: 'There is already a draft. Publish or discard it first.',
}

async function guard<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof DeskError) {
      reply.code(e.code === 'not_found' ? 404 : 409).send({ code: e.code.toUpperCase(), statusMessage: MESSAGES[e.code] ?? 'That change is not possible right now.' })
      return undefined
    }
    throw e
  }
}

const id = z.object({ id: z.string().uuid() })
const itemParams = z.object({ id: z.string().uuid(), key: z.string().regex(/^[a-z0-9_]{1,60}$/) })
const money = z.number().int().min(0).max(100_000_000).nullable()
const itemPatch = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  low: money.optional(),
  high: money.optional(),
  use: z.enum(['low', 'high']).optional(),
}).refine(p => Object.keys(p).length > 0, 'Nothing to change')

const settingsBody = z.object({
  vat: z.object({ enabled: z.boolean(), rateBp: z.number().int().min(0).max(5000) }),
  discountCapBp: z.number().int().min(0).max(10_000),
  depositBp: z.number().int().min(0).max(10_000),
  usdKesRate: z.number().min(1).max(1000),
  quoteValidityDays: z.number().int().min(1).max(90),
  includedHostingMonths: z.number().int().min(0).max(60),
  origin: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
})
const notes = z.object({ notes: z.string().trim().min(3).max(300) })

const asTable = (t: FullRateTable): RateTable => ({ id: t.id, version: t.version, effectiveFrom: t.effectiveFrom, settings: t.settings, items: t.items })

export default async function quoteRatesRoutes(fastify: FastifyInstance, opts: { desk: DeskStore }) {
  const { desk } = opts

  const published = async () => {
    const meta = (await desk.rateTables()).find(t => t.status === 'published')
    return meta ? desk.rateTable(meta.id) : null
  }
  const load = async (reply: FastifyReply, tableId: string) => {
    const t = await desk.rateTable(tableId)
    if (!t) reply.code(404).send({ code: 'NOT_FOUND', statusMessage: MESSAGES.not_found })
    return t
  }
  // Everything an edit would break, so it is refused before publishing
  const problems = (t: FullRateTable) => Object.values(modules).filter(m => m.enabled).flatMap(m => validateModule(m, asTable(t)).map(p => `${m.label}: ${p}`))

  // GET /admin/quote/rate-tables: every version, newest first
  fastify.get('/rate-tables', async (request, reply) => {
    if (!allowed(request, reply, 'rates:read')) return
    return { tables: await desk.rateTables() }
  })

  // GET /admin/quote/rate-tables/:id: prices, settings and where each is used
  fastify.get('/rate-tables/:id', async (request, reply) => {
    if (!allowed(request, reply, 'rates:read')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const t = await load(reply, params.id)
    if (!t) return
    const usage = itemUsage(modules, asTable(t))
    return {
      table: { ...t, items: undefined },
      settings: t.settings,
      items: Object.values(t.items)
        .map(i => ({ ...i, usedBy: usage[i.key] ?? [] }))
        .sort((a, b) => a.category.localeCompare(b.category) || (a.industry ?? '').localeCompare(b.industry ?? '') || a.key.localeCompare(b.key)),
      openQuotes: await desk.openQuotesOn(t.id),
      canEdit: request.quoteStaff!.role === 'admin' && t.status === 'draft',
    }
  })

  // GET /admin/quote/rate-tables/:id/impact: what publishing this would change
  fastify.get('/rate-tables/:id/impact', async (request, reply) => {
    if (!allowed(request, reply, 'rates:read')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const t = await load(reply, params.id)
    if (!t) return
    const live = await published()
    if (!live) return { against: null, items: [], settings: [], examples: [], openQuotes: 0, problems: problems(t) }
    const diff = diffTables(asTable(live), asTable(t), itemUsage(modules, asTable(t)))
    return {
      against: { id: live.id, version: live.version },
      ...diff,
      examples: examplePrices(modules, asTable(live), asTable(t)),
      // Quotes on the live table keep their prices; staff may want to re-quote them
      openQuotes: await desk.openQuotesOn(live.id),
      problems: problems(t),
    }
  })

  // POST /admin/quote/rate-tables/drafts: copy a version into a new draft
  fastify.post('/rate-tables/drafts', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const body = parseWithSchema(reply, z.object({ fromId: z.string().uuid() }), request.body)
    if (!body) return
    const draftId = await guard(reply, () => desk.createRateDraft(body.fromId, request.quoteStaff!.id))
    if (draftId) return reply.code(201).send({ id: draftId })
  })

  // PATCH /admin/quote/rate-tables/:id/items/:key: one price on a draft
  fastify.patch('/rate-tables/:id/items/:key', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const params = parseWithSchema(reply, itemParams, request.params)
    const body = params && parseWithSchema(reply, itemPatch, request.body)
    if (!params || !body) return
    const t = await load(reply, params.id)
    if (!t) return
    const item = t.items[params.key]
    if (!item) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: MESSAGES.not_found })
    const next = { ...item, ...body, ...(body.label ? { label: sanitizeLeadText(body.label, 120) } : {}) }
    if (next.low !== null && next.high !== null && next.high < next.low) {
      return reply.code(422).send({ code: 'HIGH_BELOW_LOW', statusMessage: 'The high price cannot be below the low price.' })
    }
    if (item.unit === 'bp' && ((next.low ?? 0) > 10_000 || (next.high ?? 0) > 10_000)) {
      return reply.code(422).send({ code: 'PERCENT_RANGE', statusMessage: 'A percentage must be between 0 and 100%.' })
    }
    if (next.use === 'high' && next.high === null) {
      return reply.code(422).send({ code: 'NO_HIGH', statusMessage: 'Set a high price before choosing to use it.' })
    }
    const ok = await guard(reply, async () => {
      await desk.updateRateItem(params.id, params.key, { label: next.label, low: next.low, high: next.high, use: next.use }, request.quoteStaff!.id)
      return true
    })
    if (ok) return { item: { key: params.key, label: next.label, low: next.low, high: next.high, use: next.use } }
  })

  // PUT /admin/quote/rate-tables/:id/settings: VAT, cap, deposit, validity
  fastify.put('/rate-tables/:id/settings', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, settingsBody, request.body)
    if (!params || !body) return
    const ok = await guard(reply, async () => { await desk.updateRateSettings(params.id, body, request.quoteStaff!.id); return true })
    if (ok) return { settings: body }
  })

  // POST /admin/quote/rate-tables/:id/publish: the draft becomes the live table
  fastify.post('/rate-tables/:id/publish', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, notes, request.body)
    if (!params || !body) return
    const t = await load(reply, params.id)
    if (!t) return
    const found = problems(t)
    if (found.length) return reply.code(422).send({ code: 'TABLE_PROBLEMS', statusMessage: 'Fix these before publishing.', problems: found })
    const ok = await guard(reply, async () => { await desk.publishRateTable(params.id, request.quoteStaff!.id, sanitizeLeadText(body.notes, 300)); return true })
    if (!ok) return
    clearRateCache()
    fastify.log.info({ staffId: request.quoteStaff!.id, version: t.version }, 'quote rates: published')
    return { id: params.id, version: t.version, status: 'published' }
  })

  // POST /admin/quote/rate-tables/:id/rollback: publish an old version again
  // (as a new version number, so history is never rewritten)
  fastify.post('/rate-tables/:id/rollback', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, notes, request.body)
    if (!params || !body) return
    const t = await load(reply, params.id)
    if (!t) return
    if (t.status !== 'archived') return reply.code(409).send({ code: 'NOT_ARCHIVED', statusMessage: 'Only an older, archived version can be rolled back to.' })
    const me = request.quoteStaff!.id
    const draftId = await guard(reply, () => desk.createRateDraft(t.id, me))
    if (!draftId) return
    const ok = await guard(reply, async () => { await desk.publishRateTable(draftId, me, sanitizeLeadText(body.notes, 300)); return true })
    if (!ok) return
    clearRateCache()
    const created = await desk.rateTable(draftId)
    return { id: draftId, version: created?.version, status: 'published', from: t.version }
  })

  // DELETE /admin/quote/rate-tables/:id: discard a draft
  fastify.delete('/rate-tables/:id', async (request, reply) => {
    if (!allowed(request, reply, 'rates:write')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const ok = await guard(reply, async () => { await desk.deleteRateDraft(params.id, request.quoteStaff!.id); return true })
    if (ok) return reply.code(204).send()
  })
}
