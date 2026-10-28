// Public quote form API. A visitor starts a request, saves each step with
// their resume token (the only secret; only its hash is stored) and gets a
// price after the last step. Client quote links (/quote/view/:token) are
// registered from here too; staff routes live under /admin/quote.

import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { price } from '../quote/engine/price.js'
import { normalisePhone } from '../quote/engine/phone.js'
import type { PriceResult, RateTable } from '../quote/engine/types.js'
import { modules } from '../quote/modules/index.js'
import { cleanAddons, cleanDetails } from '../quote/answers.js'
import type { QuoteStore, RequestRecord } from '../quote/store.js'
import { supabaseStore } from '../quote/supabaseStore.js'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'
import { sendPlainEmail } from '../email/index.js'
import { alertConfigFromEnv, alertNewLead, type AlertConfig } from '../quote/alerts.js'
import { CLIENT_TYPE_LABELS, PLANNED_INDUSTRIES, industryHint, industryLabel } from '../quote/industries.js'
import { supabaseDeskStore, type DeskStore } from '../quote/deskStore.js'
import { nairobiDate } from '../quote/desk.js'
import { trackServer } from '../utils/analytics.js'
import quotePublicRoutes from './quotePublic.js'
import quotePayRoutes from './quotePay.js'
import { supabaseJobStore, type JobStore } from '../quote/jobStore.js'
import { paymentDeps, type PaymentDeps } from '../quote/payments.js'
import { followupStoreFor, type FollowupStore } from '../quote/followupStore.js'
import { formCompleted, formSaved, messagingDeps, optOutValid, type MessagingDeps } from '../quote/messaging.js'

// Step order: industry first, then contact (the lead exists from step 2).
export const STEPS = ['industry', 'contact', 'details', 'extras', 'where'] as const
const stepNumber = (step: typeof STEPS[number]) => STEPS.indexOf(step) + 1

const RESUME_DAYS = Number(process.env.QUOTE_RESUME_DAYS ?? 30)

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

const clientTypeSchema = z.enum(['owner', 'agent', 'developer', 'manager', 'marketer', 'other'])
const industryHintSchema = z.enum(PLANNED_INDUSTRIES).optional()
const withHint = (flags: string[], hint?: string) => [...flags.filter(f => !f.startsWith('industry:')), ...(hint ? [`industry:${hint}`] : [])]
const moduleKeySchema = z.string().refine(k => modules[k]?.enabled, 'unknown industry')
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) })

const startSchema = z.object({
  moduleKey: moduleKeySchema,
  clientType: clientTypeSchema.optional(),
  industryHint: industryHintSchema,
  entry: z.object({
    source: z.string().trim().max(40).optional(),
    utm: z.record(z.string().regex(/^utm_[a-z]+$/), z.string().trim().max(100)).optional(),
    partnerCode: z.string().trim().max(40).optional(),
  }).optional(),
  abVariant: z.string().trim().max(20).optional(),
  website: z.string().optional(),          // honeypot: people never see or fill it
})

const stepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('industry'), moduleKey: moduleKeySchema, clientType: clientTypeSchema.optional(), industryHint: industryHintSchema }),
  z.object({
    step: z.literal('contact'),
    clientType: clientTypeSchema.optional(),
    firstName: z.string().trim().min(1).max(60),
    whatsapp: z.string().trim().min(1).max(30),
    email: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
    consent: z.boolean(),
    consentTextId: z.string().max(64).nullable().optional(),
    website: z.string().optional(),
  }),
  z.object({ step: z.literal('details'), details: z.record(z.string(), z.unknown()) }),
  z.object({ step: z.literal('extras'), addons: z.record(z.string(), z.number()) }),
  z.object({
    step: z.literal('where'),
    location: z.object({
      town: z.string().trim().max(120).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    }).refine(l => !!l.town || (l.lat !== undefined && l.lng !== undefined), 'location required'),
    timing: z.enum(['this_week', 'this_month', 'planning']),
    note: z.string().trim().max(1000).optional(),
  }),
])

const previewSchema = z.object({
  moduleKey: moduleKeySchema,
  clientType: clientTypeSchema.optional(),
  details: z.record(z.string(), z.unknown()),
  addons: z.record(z.string(), z.number()),
})

// What the visitor may see. A custom result keeps its staff draft private.
export function clientResult(r: PriceResult) {
  return {
    mode: r.mode,
    currency: r.currency,
    vat: r.vat,
    hosting: r.hosting,
    rateTableVersion: r.rateTableVersion,
    travelConfirmed: !r.warnings.some(w => w.code === 'travel_far' || w.code === 'location_unresolved'),
    options: r.mode === 'custom' ? [] : r.options,
  }
}

function publicView(req: RequestRecord) {
  return {
    moduleKey: req.moduleKey,
    clientType: req.clientType,
    industryHint: industryHint(req.flags),
    answers: req.answers,
    stepReached: req.stepReached,
    completed: !!req.completedAt,
  }
}


export default async function quoteRoutes(fastify: FastifyInstance, opts: {
  store?: QuoteStore
  desk?: DeskStore
  alerts?: AlertConfig
  onAlert?: (pending: Promise<unknown>) => void   // tests wait on the background alert
  jobs?: JobStore
  payments?: Partial<PaymentDeps>                 // tests and the dev server: fake Paystack, clock
  webhookSecret?: string
  followups?: FollowupStore
  messaging?: Partial<MessagingDeps>
}) {
  const store = opts.store ?? supabaseStore(fastify.supabase)
  const alerts = opts.alerts ?? alertConfigFromEnv(sendPlainEmail)
  const desk = opts.desk ?? supabaseDeskStore(fastify.supabase)
  const jobs = opts.jobs ?? supabaseJobStore(fastify.supabase)
  const followups = opts.followups ?? followupStoreFor(store, fastify.supabase)
  const messaging = messagingDeps({ store, desk, jobs, followups, alerts, log: fastify.log }, opts.messaging)

  // Follow-ups never hold up or break the form: they run after the answer
  // is saved, and a failure is logged (the answers are already stored)
  const followUp = (what: string, leadId: string, run: () => Promise<unknown>) => {
    const pending = run().catch(err => fastify.log.error({ err: err instanceof Error ? err.message : String(err), leadId }, `quote: follow-up ${what} failed`))
    opts.onAlert?.(pending)
  }

  async function rateTableOr503(reply: FastifyReply): Promise<RateTable | null> {
    const table = await store.publishedRateTable()
    if (!table) {
      reply.code(503).send({ code: 'NO_RATE_TABLE', statusMessage: 'Prices are being updated. Please try again shortly or WhatsApp us.' })
      return null
    }
    return table
  }

  async function loadRequest(token: string, reply: FastifyReply): Promise<RequestRecord | null> {
    const req = await store.findRequest(hashToken(token))
    if (!req) { reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'This link is not valid.' }); return null }
    if (messaging.now().getTime() - Date.parse(req.lastSavedAt) > RESUME_DAYS * 86_400_000) {
      reply.code(410).send({ code: 'EXPIRED', statusMessage: 'This link has expired. Start a new quote; it takes about a minute.' })
      return null
    }
    return req
  }

  // GET /quote/config: modules, add-on prices and consent wording for the form
  fastify.get('/config', async (_request, reply) => {
    const table = await rateTableOr503(reply)
    if (!table) return
    const consent = await store.consentText('en')
    const itemPrice = (key?: string) => (key && table.items[key]?.low !== undefined ? table.items[key].low : null)
    const enabled = Object.values(modules).filter(m => m.enabled)
    reply.header('Cache-Control', 'public, max-age=60')
    return {
      rateTableVersion: table.version,
      settings: {
        depositBp: table.settings.depositBp,
        vat: table.settings.vat,
        includedHostingMonths: table.settings.includedHostingMonths,
        quoteValidityDays: table.settings.quoteValidityDays,
      },
      consent,
      modules: enabled.map(m => {
        const optionPrices = m.questions.flatMap(q => q.options ?? []).map(o => itemPrice(o.rateKey)).filter((v): v is number => typeof v === 'number')
        return {
          key: m.key,
          version: m.version,
          label: m.label,
          resultMode: m.resultMode,
          from: m.resultMode === 'custom' || !optionPrices.length ? null : Math.min(...optionPrices),
          questions: m.questions.map(q => ({
            ...q,
            options: q.options?.map(o => ({
              value: o.value, label: o.label,
              price: o.rateKey && !table.items[o.rateKey]?.custom ? itemPrice(o.rateKey) : null,
            })),
          })),
          addons: m.pricing.addons
            .map(key => table.items[key])
            .filter(i => i && !i.custom)
            // A percentage add-on (rush) has no fixed price until the order is known
            .map(i => i.unit === 'bp'
              ? { key: i.key, label: i.label, unit: i.unit, amount: null, percentBp: i.low }
              : { key: i.key, label: i.label, unit: i.unit, amount: i.use === 'high' ? (i.high ?? i.low) : i.low }),
        }
      }),
    }
  })

  // POST /quote/preview: the running total on the extras step. Prices the
  // answers so far with the real engine (no location yet, so before travel);
  // nothing is stored.
  fastify.post('/preview', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, previewSchema, request.body)
    if (!body) return
    const module = modules[body.moduleKey]
    const { details, errors } = cleanDetails(module, body.details)
    const { addons, errors: addonErrors } = cleanAddons(module, body.addons)
    if (errors.length || addonErrors.length) return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [...errors, ...addonErrors] })
    const table = await rateTableOr503(reply)
    if (!table) return
    const result = price(module, { clientType: body.clientType, details, addons }, table)
    const picked = result.options.find(o => o.tier === 'standard') ?? result.options[0]
    if (result.mode === 'custom' || !picked) return { mode: result.mode, currency: result.currency, beforeTravel: null }
    const travel = picked.lines.filter(l => l.kind === 'travel').reduce((sum, l) => sum + l.amount, 0)
    return { mode: result.mode, currency: result.currency, beforeTravel: picked.total - travel }
  })

  // POST /quote/requests: step 1, start a request
  fastify.post('/requests', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, startSchema, request.body)
    if (!body) return
    const token = crypto.randomBytes(24).toString('base64url')
    if (body.website) {
      // Bot filled the honeypot: answer like a success, store nothing
      return reply.code(201).send({ token, request: { moduleKey: body.moduleKey, stepReached: 1, completed: false } })
    }
    const module = modules[body.moduleKey]
    const created = await store.createRequest({
      moduleKey: module.key,
      moduleVersion: module.version,
      clientType: body.clientType ?? null,
      entry: { source: body.entry?.source, utm: body.entry?.utm, partnerCode: body.entry?.partnerCode },
      abVariant: body.abVariant ?? null,
      device: { ua: String(request.headers['user-agent'] ?? '').slice(0, 200) },
      stepReached: 1,
    }, hashToken(token))
    const hinted = body.moduleKey === 'other' && body.industryHint
      ? await store.updateRequest(created.id, { flags: withHint(created.flags, body.industryHint) })
      : created
    return reply.code(201).send({ token, request: publicView(hinted) })
  })

  // GET /quote/requests/:token: resume
  fastify.get('/requests/:token', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } },
  }, async (request, reply) => {
    const params = parseWithSchema(reply, tokenParams, request.params)
    if (!params) return
    const req = await loadRequest(params.token, reply)
    if (!req) return
    const lead = req.leadId ? await store.getLead(req.leadId) : null
    const quote = req.completedAt ? await store.latestQuote(req.id) : null
    return {
      request: publicView(req),
      contact: lead ? { firstName: lead.firstName, whatsapp: lead.whatsappE164, email: lead.email } : null,
      result: quote ? clientResult(quote) : null,
    }
  })

  // PATCH /quote/requests/:token: save one step
  fastify.patch('/requests/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } },
  }, async (request, reply) => {
    const params = parseWithSchema(reply, tokenParams, request.params)
    if (!params) return
    const body = parseWithSchema(reply, stepSchema, request.body)
    if (!body) return
    const req = await loadRequest(params.token, reply)
    if (!req) return

    const reached = Math.max(req.stepReached, stepNumber(body.step))
    const needsModule = () => {
      const m = req.moduleKey ? modules[req.moduleKey] : undefined
      if (!m) reply.code(409).send({ code: 'INDUSTRY_REQUIRED', statusMessage: 'Pick what we are shooting first.' })
      return m
    }

    if (body.step === 'industry') {
      const module = modules[body.moduleKey]
      const changed = module.key !== req.moduleKey
      const next = await store.updateRequest(req.id, {
        moduleKey: module.key, moduleVersion: module.version, stepReached: reached,
        ...(body.clientType ? { clientType: body.clientType } : {}),
        flags: withHint(req.flags, module.key === 'other' ? body.industryHint : undefined),
        // A different industry asks different questions, so its old details go
        ...(changed ? { answers: { ...req.answers, details: {}, addons: {} } } : {}),
      })
      return { request: publicView(next) }
    }

    if (body.step === 'contact') {
      if (body.website) return { request: publicView(req) }
      const phone = normalisePhone(body.whatsapp)
      if (!phone.ok) {
        return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: [{ field: 'whatsapp', message: phone.reason }] })
      }
      const consent = body.consent ? await store.consentText('en') : null
      const lead = await store.upsertLead({
        firstName: sanitizeLeadText(body.firstName, 60),
        whatsappE164: phone.e164,
        email: body.email ? body.email.toLowerCase() : null,
        consentWhatsapp: body.consent,
        consentEmail: body.consent && !!body.email,
        consentTextId: consent?.id ?? null,
        source: req.entry.source ?? null,
        utm: req.entry.utm ?? {},
      })
      const next = await store.updateRequest(req.id, { leadId: lead.id, stepReached: reached, ...(body.clientType ? { clientType: body.clientType } : {}) })
      if (!next.completedAt) followUp('start', lead.id, () => formSaved(messaging, lead.id, { first: true }))
      if (lead.created) {
        fastify.log.info({ requestId: req.id, module: req.moduleKey }, 'quote: new lead')
        // In the background: the visitor never waits on email, and a failure is recorded, not thrown
        const clientType = body.clientType ?? req.clientType
        const pending = alertNewLead(store, alerts, fastify.log, {
          leadId: lead.id,
          firstName: sanitizeLeadText(body.firstName, 60),
          industry: industryLabel(req.moduleKey, req.flags, req.moduleKey ? modules[req.moduleKey]?.label : undefined),
          clientType: clientType ? CLIENT_TYPE_LABELS[clientType] ?? clientType : 'Not given',
          source: req.entry.source ?? null,
        }).catch(err => fastify.log.error({ err, leadId: lead.id }, 'quote: new-lead alert crashed'))
        opts.onAlert?.(pending)
      }
      return { request: publicView(next) }
    }

    const module = needsModule()
    if (!module) return

    if (body.step === 'details') {
      const { details, errors } = cleanDetails(module, body.details)
      if (errors.length) return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: errors })
      const next = await store.updateRequest(req.id, { answers: { ...req.answers, details }, stepReached: reached })
      if (next.leadId && !next.completedAt) followUp('touch', next.leadId, () => formSaved(messaging, next.leadId!, { first: false }))
      return { request: publicView(next) }
    }

    if (body.step === 'extras') {
      const { addons, errors } = cleanAddons(module, body.addons)
      if (errors.length) return reply.code(400).send({ code: 'VALIDATION_ERROR', fields: errors })
      const next = await store.updateRequest(req.id, { answers: { ...req.answers, addons }, stepReached: reached })
      if (next.leadId && !next.completedAt) followUp('touch', next.leadId, () => formSaved(messaging, next.leadId!, { first: false }))
      return { request: publicView(next) }
    }

    // where: the last step prices the request and saves the quote
    if (!req.leadId) return reply.code(409).send({ code: 'CONTACT_REQUIRED', statusMessage: 'Add your WhatsApp number so we can send your price.' })
    const table = await rateTableOr503(reply)
    if (!table) return
    const answers = {
      ...req.answers,
      location: body.location,
      timing: body.timing,
      ...(body.note ? { note: sanitizeLeadText(body.note, 1000) } : {}),
    }
    const result = price(module, {
      clientType: req.clientType ?? undefined,
      details: answers.details,
      addons: answers.addons,
      location: answers.location,
    }, table)
    const quoteId = await store.saveQuote(req.id, result, {
      validUntil: nairobiDate(messaging.now(), table.settings.quoteValidityDays),
      depositBp: table.settings.depositBp,
    })
    const next = await store.updateRequest(req.id, {
      answers,
      stepReached: reached,
      flags: [...new Set([...req.flags, ...result.flags])],
      completedAt: req.completedAt ?? messaging.now().toISOString(),
    })
    const picked = result.options.find(o => o.tier === 'standard') ?? result.options[0]
    const leadId = req.leadId
    followUp('quote', leadId, () => formCompleted(messaging, {
      leadId, quoteId, mode: result.mode, total: picked?.total ?? null, source: req.entry.source ?? null,
      industry: industryLabel(req.moduleKey, next.flags, module.label),
    }))
    return { request: publicView(next), result: clientResult(result) }
  })

  // Opt-out link from an email: /quote/stop?l=<lead>&s=<signature>
  const stopQuery = z.object({ l: z.string().uuid(), s: z.string().regex(/^[A-Za-z0-9_-]{32}$/) })
  const stopLimit = { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } }
  fastify.get('/stop', { config: stopLimit }, async (request, reply) => {
    const q = parseWithSchema(reply, stopQuery, request.query)
    if (!q) return
    if (!messaging.optOutSecret || !optOutValid(messaging.optOutSecret, q.l, q.s)) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'This link is not valid. WhatsApp us and we will stop the messages.' })
    const lead = await followups.lead(q.l)
    if (!lead) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'We have no details for you any more, so you will not hear from us.' })
    return { optedOut: !!lead.optedOutAt }
  })
  fastify.post('/stop', { config: stopLimit }, async (request, reply) => {
    const q = parseWithSchema(reply, stopQuery, request.body)
    if (!q) return
    if (!messaging.optOutSecret || !optOutValid(messaging.optOutSecret, q.l, q.s)) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'This link is not valid. WhatsApp us and we will stop the messages.' })
    await followups.optOut(q.l, null, 'email_link')
    return { optedOut: true }
  })

  const payments = paymentDeps({ jobs, desk, store, log: fastify.log }, { alerts, followups, ...opts.payments })
  await fastify.register(quotePublicRoutes, {
    desk, jobs, paymentsOn: !!payments.paystack, now: payments.now,
    // Analytics carry the quote id only, never personal data
    onViewed: (quoteId, firstView) => trackServer(`quote:${quoteId}`, 'quote opened', { firstView }),
  })
  await fastify.register(quotePayRoutes, {
    desk, jobs, payments,
    webhookSecret: opts.webhookSecret ?? process.env.QUOTE_PAYSTACK_SECRET_KEY ?? null,
  })
}
