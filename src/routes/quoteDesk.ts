// Quote desk routes (under /admin/quote): the lead board, lead stage, owner
// and notes, and building, approving and sending quotes. The staff check
// runs in quoteAdmin.ts before every route here.
//
// Sending: a WhatsApp send returns a wa.me link for the staff member to
// press send on their own phone (nothing is sent by the server). Email is
// sandboxed unless QUOTE_MESSAGES_SEND=1; in sandbox the message is recorded
// on the lead as skipped and the quote link still works.

import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'
import { sendPlainEmail } from '../email/index.js'
import type { QuoteAdminStore } from '../quote/adminStore.js'
import type { QuoteStore } from '../quote/store.js'
import { DeskError, type DeskStore, type LeadStage } from '../quote/deskStore.js'
import { allowed } from '../quote/staffAuth.js'
import {
  EDITABLE, VERSION_ON_EDIT, blankDraft, checkDoc, docFromEngine, firmTiers, formatKes, inQuietHours,
  linkExpiry, nairobiDate, nextDraft, recalc, sendBlocker, type QuoteDoc, type StaffRole,
} from '../quote/desk.js'
import { price } from '../quote/engine/price.js'
import type { RateTable } from '../quote/engine/types.js'
import { modules } from '../quote/modules/index.js'
import { industryLabel } from '../quote/industries.js'
import { answersView } from '../quote/answersView.js'
import { render } from '../quote/alerts.js'
import { publicQuote } from '../quote/publicQuote.js'
import { renderQuotePdf } from '../quote/pdf.js'

export interface DeskRouteOptions {
  adminStore: QuoteAdminStore
  store: QuoteStore
  desk: DeskStore
  messagesLive?: boolean                 // default: QUOTE_MESSAGES_SEND === '1'
  sendEmail?: typeof sendPlainEmail
  publicUrl?: string                     // default: QUOTE_PUBLIC_URL or https://app.viewora.software
  whatsappNumber?: string                // shown on the PDF; default QUOTE_WHATSAPP
  now?: () => Date
  newToken?: () => string
}

export const STAGES: LeadStage[] = ['new', 'contacted', 'quoted', 'booked', 'delivered', 'paid', 'lost']
export const TEMPLATE_QUOTE_LINK = 'quote_link'

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
const clean = (s: string | null | undefined, max: number) => (s ? sanitizeLeadText(s, max).trim() || null : null)

const MESSAGES: Record<string, string> = {
  not_found: 'That quote or lead no longer exists.',
  locked: 'This quote can no longer change. Make a new version from the lead.',
  needs_approval: 'An admin needs to approve the discount before this quote can be sent.',
  not_waiting: 'This quote is not waiting for approval any more.',
  owner_not_staff: 'Pick an active staff member as the owner.',
  opted_out: 'This lead asked not to be contacted. Do not send them anything.',
  no_lines: 'Add at least one line before sending.',
  tbc_lines: 'Confirm the prices marked "to be confirmed" before sending.',
  validity_past: 'The "valid until" date has passed. Pick a new date first.',
}

function conflict(reply: FastifyReply, code: string, status = 409) {
  return reply.code(status).send({ code: code.toUpperCase(), statusMessage: MESSAGES[code] ?? 'That change is not possible right now.' })
}

async function guard<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof DeskError) { conflict(reply, e.code, e.code === 'not_found' ? 404 : 409); return undefined }
    throw e
  }
}

const id = z.object({ id: z.string().uuid() })
const reason = z.object({ reason: z.string().trim().min(3).max(300) })

const lineSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,60}$/).nullable(),
  kind: z.enum(['base', 'per_unit', 'uplift', 'addon', 'discount', 'minimum', 'travel']),
  label: z.string().trim().min(1).max(120),
  qty: z.number().int().min(1).max(10_000),
  unit: z.number().int().min(-100_000_000).max(100_000_000),
  tbc: z.boolean().default(false),
  note: z.string().trim().max(200).nullable().default(null),
})

const quoteBody = z.object({
  vatCharged: z.boolean(),
  depositBp: z.number().int().min(0).max(10_000),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  discountReason: z.string().trim().max(300).nullable(),
  clientNote: z.string().trim().max(1000).nullable(),
  options: z.array(z.object({
    tier: z.enum(['essential', 'standard', 'premium', 'estimate', 'draft']),
    selected: z.boolean(),
    lines: z.array(lineSchema).max(40),
  })).min(1).max(3),
}).refine(b => new Set(b.options.map(o => (o.tier === 'estimate' || o.tier === 'draft' ? 'standard' : o.tier))).size === b.options.length,
  { message: 'Each option must be a different tier', path: ['options'] })

const boardQuery = z.object({
  owner: z.union([z.string().uuid(), z.literal('none')]).optional(),
  industry: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().max(100).optional(),
})

const leadPatch = z.object({
  stage: z.enum(STAGES as [LeadStage, ...LeadStage[]]).optional(),
  ownerId: z.string().uuid().nullable().optional(),
}).refine(p => p.stage !== undefined || p.ownerId !== undefined, 'Nothing to change')

const sendBody = z.object({ channel: z.enum(['link', 'whatsapp', 'email']) })

const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' })

const listPrice = (table: RateTable | null) => (key: string) => {
  const item = table?.items[key]
  if (!item || item.unit === 'bp') return null
  return (item.use === 'high' ? item.high ?? item.low : item.low) ?? null
}

// The discount each option gives, by tier: an approval stands while these don't change
const discountShape = (doc: QuoteDoc) => JSON.stringify(firmTiers(doc).options.map(o => [o.tier, o.discountBp]).sort())

export default async function quoteDeskRoutes(fastify: FastifyInstance, opts: DeskRouteOptions) {
  const { adminStore, store, desk } = opts
  const now = opts.now ?? (() => new Date())
  const messagesLive = opts.messagesLive ?? process.env.QUOTE_MESSAGES_SEND === '1'
  const sendEmail = opts.sendEmail ?? sendPlainEmail
  const publicUrl = (opts.publicUrl ?? process.env.QUOTE_PUBLIC_URL ?? 'https://app.viewora.software').replace(/\/$/, '')
  const whatsappNumber = opts.whatsappNumber ?? process.env.QUOTE_WHATSAPP ?? '254117537025'
  const newToken = opts.newToken ?? (() => crypto.randomBytes(32).toString('base64url'))

  const loadQuote = async (reply: FastifyReply, quoteId: string) => {
    const doc = await desk.quote(quoteId)
    if (!doc) { conflict(reply, 'not_found', 404); return null }
    return recalc(doc)
  }

  // GET /admin/quote/staff: who is asking (role decides which buttons show)
  // and the people a lead can be assigned to
  fastify.get('/staff', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const list = await desk.staffList()
    const me = request.quoteStaff!
    return {
      me: { id: me.id, name: me.displayName, role: me.role, discountLimitBp: me.discountLimitBp },
      staff: list.filter(s => s.role !== 'viewer').map(s => ({ id: s.userId, name: s.displayName, role: s.role })),
    }
  })

  // GET /admin/quote/board: leads by stage, newest activity first (50 per column)
  fastify.get('/board', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const query = parseWithSchema(reply, boardQuery, request.query)
    if (!query) return
    const columns = await Promise.all(STAGES.map(stage =>
      adminStore.leads({ ...query, q: query.q || undefined, stage, limit: 50, offset: 0 })))
    return { columns: STAGES.map((stage, i) => ({ stage, total: columns[i].total, rows: columns[i].rows })) }
  })

  // PATCH /admin/quote/leads/:id: move to a stage, or change the owner
  fastify.patch('/leads/:id', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, leadPatch, request.body)
    if (!params || !body) return
    const lead = await guard(reply, () => desk.updateLead(params.id, {
      ...(body.stage ? { stage: body.stage } : {}),
      ...(body.ownerId !== undefined ? { ownerStaffId: body.ownerId } : {}),
    }, request.quoteStaff!.id))
    if (lead) return { lead }
  })

  // POST /admin/quote/leads/:id/notes
  fastify.post('/leads/:id/notes', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, z.object({ body: z.string().trim().min(1).max(2000) }), request.body)
    if (!params || !body) return
    const text = clean(body.body, 2000)
    if (!text) return reply.code(422).send({ code: 'EMPTY_NOTE', statusMessage: 'Write something first.' })
    const note = await guard(reply, () => desk.addNote(params.id, request.quoteStaff!.id, text))
    if (note) return reply.code(201).send({ note })
  })

  // POST /admin/quote/leads/:id/quotes: open the draft, or start the next version
  fastify.post('/leads/:id/quotes', async (request, reply) => {
    if (!allowed(request, reply, 'quotes:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, z.object({ requestId: z.string().uuid().optional() }), request.body ?? {})
    if (!params || !body) return
    const me = request.quoteStaff!
    const lead = await desk.lead(params.id)
    if (!lead) return conflict(reply, 'not_found', 404)
    const requestId = body.requestId ?? await desk.latestRequestId(lead.id)
    const ctx = requestId ? await desk.request(requestId) : null
    if (!ctx || ctx.leadId !== lead.id) {
      return reply.code(409).send({ code: 'NO_REQUEST', statusMessage: 'This lead has no form answers to quote from yet.' })
    }
    const table = await store.publishedRateTable()
    if (!table) return reply.code(503).send({ code: 'NO_RATE_TABLE', statusMessage: 'No published rate table. Publish one first.' })
    const validUntil = nairobiDate(now(), table.settings.quoteValidityDays)

    let doc: QuoteDoc
    const latest = ctx.latestQuoteId ? await desk.quote(ctx.latestQuoteId) : null
    if (latest && EDITABLE.includes(latest.status)) return { id: latest.id, created: false }
    if (latest) {
      doc = nextDraft(latest, { version: latest.version + 1, createdBy: me.id, validUntil })
    } else {
      const module = ctx.moduleKey ? modules[ctx.moduleKey] : undefined
      const result = module ? price(module, {
        clientType: (ctx.clientType ?? undefined) as any, details: ctx.answers.details ?? {},
        addons: ctx.answers.addons ?? {}, location: ctx.answers.location,
      }, table) : null
      doc = result?.options.length
        ? firmTiers(docFromEngine(result, { requestId: ctx.id, leadId: lead.id, version: 1, depositBp: table.settings.depositBp, validUntil, status: 'draft', createdBy: me.id }))
        : blankDraft({
          requestId: ctx.id, leadId: lead.id, version: 1, createdBy: me.id, validUntil, depositBp: table.settings.depositBp,
          vatCharged: table.settings.vat.enabled, vatRateBp: table.settings.vat.rateBp, rateTableId: table.id, rateTableVersion: table.version,
        })
    }
    const quoteId = await guard(reply, () => desk.saveQuote(recalc(doc), me.id, { action: 'created' }))
    if (quoteId) return reply.code(201).send({ id: quoteId, created: true })
  })

  // GET /admin/quote/quotes/:id: the editor's data
  fastify.get('/quotes/:id', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const loaded = await loadQuote(reply, params.id)
    if (!loaded) return
    // A draft is shown as staff will save it: estimates and drafts as Standard
    const doc = EDITABLE.includes(loaded.status) ? recalc(firmTiers(loaded)) : loaded
    const me = request.quoteStaff!
    const [lead, ctx, table] = await Promise.all([
      doc.leadId ? desk.lead(doc.leadId) : null, desk.request(doc.requestId), desk.rateTable(doc.rateTableId),
    ])
    const detail = doc.leadId ? await adminStore.lead(doc.leadId) as any : null
    const versions = ((detail?.requests ?? []).find((r: any) => r.id === doc.requestId)?.quotes ?? [])
      .map((q: any) => ({ id: q.id, version: q.version, status: q.status, sentAt: q.sentAt, createdByName: q.createdByName }))
    const check = checkDoc(doc, { role: me.role, discountLimitBp: me.discountLimitBp, discountCapBp: table?.settings.discountCapBp ?? 2000, listPrice: listPrice(table) })
    const itemLabel = (key: string) => table?.items[key]?.label ?? key
    return {
      quote: doc,
      lead,
      industry: ctx ? industryLabel(ctx.moduleKey, ctx.flags, ctx.moduleKey ? modules[ctx.moduleKey]?.label : undefined) : null,
      answers: ctx ? answersView(ctx, itemLabel) : [],
      // Extras staff can add from the quote's own rate table version
      catalogue: Object.values(table?.items ?? {})
        .filter(i => i.category === 'addon' && !i.custom && i.unit !== 'bp' && listPrice(table)(i.key) !== null)
        .map(i => ({ key: i.key, label: i.label, unit: listPrice(table)(i.key)! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      settings: { discountCapBp: table?.settings.discountCapBp ?? 2000, rateTableVersion: doc.rateTableVersion },
      me: { role: me.role, discountLimitBp: me.discountLimitBp },
      editable: EDITABLE.includes(doc.status) || VERSION_ON_EDIT.includes(doc.status),
      newVersionOnSave: VERSION_ON_EDIT.includes(doc.status),
      check,
      sendBlocker: sendBlocker(doc, nairobiDate(now()), !!lead?.optedOutAt),
      quietHours: inQuietHours(now()),
      messagesLive,
      versions,
    }
  })

  // A staff edit as the server will save it: totals recomputed, labels cleaned
  const editedDoc = (current: QuoteDoc, body: z.infer<typeof quoteBody>, me: { id: string }) => {
    const inPlace = EDITABLE.includes(current.status)
    const base = inPlace ? current : nextDraft(current, { version: current.version + 1, createdBy: me.id, validUntil: body.validUntil })
    return recalc(firmTiers({
      ...base,
      vatCharged: body.vatCharged,
      depositBp: body.depositBp,
      validUntil: body.validUntil,
      discountReason: clean(body.discountReason, 300),
      clientNote: clean(body.clientNote, 1000),
      options: body.options.map(o => ({
        tier: o.tier, selected: o.selected, subtotal: 0, discount: 0, discountBp: 0, net: 0, vat: 0, total: 0, deposit: 0,
        lines: o.lines.map(l => ({ ...l, label: clean(l.label, 120) ?? 'Item', note: clean(l.note, 200), amount: 0 })),
      })),
    }))
  }
  const checkFor = async (doc: QuoteDoc, me: { role: StaffRole; discountLimitBp: number }) => {
    const table = await desk.rateTable(doc.rateTableId)
    const capBp = table?.settings.discountCapBp ?? 2000
    return { capBp, check: checkDoc(doc, { role: me.role, discountLimitBp: me.discountLimitBp, discountCapBp: capBp, listPrice: listPrice(table) }) }
  }
  const validityProblem = (validUntil: string) =>
    validUntil < nairobiDate(now()) || validUntil > nairobiDate(now(), 180)
      ? { code: 'VALIDITY_RANGE', statusMessage: 'Pick a "valid until" date between today and 6 months from now.' }
      : null

  // POST /admin/quote/quotes/:id/check: what a save would do, without saving
  // (the editor calls it as staff type, so the rules live in one place)
  fastify.post('/quotes/:id/check', async (request, reply) => {
    if (!allowed(request, reply, 'quotes:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, quoteBody, request.body)
    if (!params || !body) return
    const me = request.quoteStaff!
    const current = await loadQuote(reply, params.id)
    if (!current) return
    if (!EDITABLE.includes(current.status) && !VERSION_ON_EDIT.includes(current.status)) return conflict(reply, 'locked')
    const doc = editedDoc(current, body, me)
    const { check } = await checkFor(doc, me)
    const stillApproved = !!current.discountApprovedBy && discountShape(current) === discountShape(doc)
    const validity = validityProblem(body.validUntil)
    return {
      options: doc.options,
      errors: [...check.errors, ...(validity ? [{ code: 'validity_range' }] : [])],
      needsApproval: me.role !== 'admin' && check.needsApproval && !stillApproved,
      approvalReasons: check.approvalReasons,
      staffDiscountBp: check.staffDiscountBp,
    }
  })

  // PUT /admin/quote/quotes/:id: save edits (a sent quote becomes a new version)
  fastify.put('/quotes/:id', async (request, reply) => {
    if (!allowed(request, reply, 'quotes:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, quoteBody, request.body)
    if (!params || !body) return
    const me = request.quoteStaff!
    const current = await loadQuote(reply, params.id)
    if (!current) return
    const inPlace = EDITABLE.includes(current.status)
    if (!inPlace && !VERSION_ON_EDIT.includes(current.status)) return conflict(reply, 'locked')

    const validity = validityProblem(body.validUntil)
    if (validity) return reply.code(422).send(validity)
    let doc = editedDoc(current, body, me)
    const { capBp, check } = await checkFor(doc, me)
    if (check.errors.length) {
      return reply.code(422).send({ code: 'INVALID_QUOTE', statusMessage: 'Some lines need fixing before this can be saved.', errors: check.errors })
    }
    // An earlier approval stands while the discounts stay the same
    const stillApproved = !!current.discountApprovedBy && discountShape(current) === discountShape(doc)
    const overCap = check.approvalReasons.some(r => r.code === 'over_cap')
      || doc.options.some(o => o.discountBp > capBp)
    if (me.role === 'admin') {
      doc = { ...doc, status: 'draft', discountApprovedBy: check.staffDiscountBp > 0 || overCap ? me.id : null }
    } else if (check.needsApproval && !stillApproved) {
      doc = { ...doc, status: 'needs_approval', discountApprovedBy: null }
    } else {
      doc = { ...doc, status: 'draft', discountApprovedBy: stillApproved ? current.discountApprovedBy : null }
    }
    const savedId = await guard(reply, () => desk.saveQuote(doc, me.id, { action: inPlace ? 'edited' : 'new_version' }))
    if (!savedId) return
    return { id: savedId, created: !inPlace, status: doc.status, approvalReasons: doc.status === 'needs_approval' ? check.approvalReasons : [] }
  })

  // POST /admin/quote/quotes/:id/approve | reject: an admin decides on a discount
  for (const decision of ['approve', 'reject'] as const) {
    fastify.post(`/quotes/:id/${decision}`, async (request, reply) => {
      if (!allowed(request, reply, 'quotes:approve')) return
      const params = parseWithSchema(reply, id, request.params)
      const body = params && parseWithSchema(reply, reason, request.body)
      if (!params || !body) return
      const ok = await guard(reply, async () => { await desk.decideApproval(params.id, request.quoteStaff!.id, decision === 'approve', clean(body.reason, 300)!); return true })
      if (ok) return { id: params.id, status: 'draft', approved: decision === 'approve' }
    })
  }

  // POST /admin/quote/quotes/:id/lost
  fastify.post('/quotes/:id/lost', async (request, reply) => {
    if (!allowed(request, reply, 'quotes:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, reason, request.body)
    if (!params || !body) return
    const ok = await guard(reply, async () => { await desk.setQuoteLost(params.id, request.quoteStaff!.id, clean(body.reason, 300)!); return true })
    if (ok) return { id: params.id, status: 'lost' }
  })

  // POST /admin/quote/quotes/:id/send: make a client link, and hand it over
  fastify.post('/quotes/:id/send', async (request, reply) => {
    if (!allowed(request, reply, 'quotes:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, sendBody, request.body)
    if (!params || !body) return
    const me = request.quoteStaff!
    const doc = await loadQuote(reply, params.id)
    if (!doc) return
    const lead = doc.leadId ? await desk.lead(doc.leadId) : null
    if (!lead) return conflict(reply, 'not_found', 404)
    const blocker = sendBlocker(doc, nairobiDate(now()), !!lead.optedOutAt)
    if (blocker) return conflict(reply, blocker)
    const channel = body.channel
    if (channel !== 'link' && inQuietHours(now())) {
      return reply.code(409).send({ code: 'QUIET_HOURS', statusMessage: 'We only message clients between 07:00 and 21:00 Nairobi time. Copy the link now, or send after 07:00.' })
    }
    if (channel === 'email' && !lead.email) return reply.code(409).send({ code: 'NO_EMAIL', statusMessage: 'This lead gave no email address. Send by WhatsApp instead.' })
    if (channel === 'whatsapp' && !lead.whatsappE164) return reply.code(409).send({ code: 'NO_WHATSAPP', statusMessage: 'This lead has no WhatsApp number.' })

    const template = channel === 'link' ? null : await store.messageTemplate(TEMPLATE_QUOTE_LINK, channel)
    if (channel !== 'link' && !template) {
      return reply.code(409).send({ code: 'TEMPLATE_MISSING', statusMessage: `The "${TEMPLATE_QUOTE_LINK}" ${channel} wording is missing. Add it in qe_message_templates.` })
    }

    const ctx = await desk.request(doc.requestId)
    const industry = ctx ? industryLabel(ctx.moduleKey, ctx.flags, ctx.moduleKey ? modules[ctx.moduleKey]?.label : undefined) : ''
    const token = newToken()
    const url = `${publicUrl}/quote/view/${token}`
    const selected = doc.options.find(o => o.selected) ?? doc.options[0]
    const vars = {
      name: lead.firstName ?? '', industry, quote_link: url,
      amount: formatKes(selected.total, doc.currency), valid_until: doc.validUntil ? longDate(doc.validUntil) : '',
      staff_name: me.displayName ?? 'The Viewora team',
    }

    const sent = await guard(reply, async () => {
      await desk.markSent(doc.id!, me.id, { tokenHash: hashToken(token), channel, expiresAt: linkExpiry(doc.validUntil, now()) })
      return true
    })
    if (!sent) return
    const result: Record<string, unknown> = { url, sandbox: !messagesLive }

    if (channel === 'whatsapp' && template) {
      const text = render(template.body, vars)
      result.waUrl = `https://wa.me/${lead.whatsappE164!.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
      // Click-to-chat: the staff member presses send on their own WhatsApp
      await store.recordMessage({
        leadId: lead.id, quoteId: doc.id, channel: 'whatsapp', templateKey: TEMPLATE_QUOTE_LINK, templateVersion: template.version,
        renderedBody: text, status: 'sent', skipReason: 'click_to_chat', sentAt: now().toISOString(),
      })
    }

    if (channel === 'email' && template) {
      const subject = render(template.subject ?? 'Your Viewora quote', vars)
      const text = render(template.body, vars)
      const sentDoc = { ...doc, status: doc.status === 'draft' ? 'sent' as const : doc.status, sentAt: doc.sentAt ?? now().toISOString() }
      const view = publicQuote({ linkId: '', expiresAt: linkExpiry(doc.validUntil, now()), revoked: false, quote: sentDoc, lead, moduleKey: ctx?.moduleKey ?? null, flags: ctx?.flags ?? [], replacedAt: null }, now())
      const base = { leadId: lead.id, quoteId: doc.id, channel: 'email' as const, templateKey: TEMPLATE_QUOTE_LINK, templateVersion: template.version, renderedBody: text }
      if (!messagesLive) {
        await store.recordMessage({ ...base, status: 'skipped', skipReason: 'sandbox' })
        result.email = { status: 'skipped', skipReason: 'sandbox' }
      } else {
        try {
          const pdf = await renderQuotePdf(view, { whatsapp: whatsappNumber })
          await sendEmail({ to: [lead.email!], subject, text, attachments: [{ filename: `Viewora-quote-${view.ref}.pdf`, content: pdf }] })
          await store.recordMessage({ ...base, status: 'sent', sentAt: now().toISOString() })
          result.email = { status: 'sent' }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e)
          fastify.log.error({ err: error, quoteId: doc.id }, 'quote desk: quote email failed')
          await store.recordMessage({ ...base, status: 'failed', error })
          result.email = { status: 'failed', error: 'The email did not go through. Copy the link and send it by WhatsApp.' }
        }
      }
    }
    return result
  })
}
