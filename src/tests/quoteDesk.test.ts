import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import {
  checkDoc, docFromEngine, firmTiers, formatKes, inQuietHours, linkExpiry, nairobiDate, nextDraft, recalc, sendBlocker,
  type QuoteDoc,
} from '../quote/desk.js'
import { price } from '../quote/engine/price.js'
import { modules } from '../quote/modules/index.js'
import { diffTables, examplePrices, itemUsage } from '../quote/rates.js'
import { renderQuotePdf } from '../quote/pdf.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const NOBODY = '00000000-0000-4000-8000-000000000003'   // signed in, but no staff row
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })

// ── Pure rules ──────────────────────────────────────────────────────────────

const homes = (addons: Record<string, number> = {}) =>
  price(modules.homes, { clientType: 'owner', details: { size: '2br', purpose: 'let' }, addons, location: { town: 'Nairobi' } }, rateTableV1)
const formDoc = (status: QuoteDoc['status'] = 'sent') =>
  ({ ...docFromEngine(homes({ reel: 1 }), { requestId: 'r1', leadId: 'l1', version: 1, depositBp: 5000, validUntil: '2026-11-04', status }), id: 'q1' })
const ctx = { role: 'sales' as const, discountLimitBp: 500, discountCapBp: 2000 }
const withDiscount = (doc: QuoteDoc, amount: number) => recalc({
  ...doc, discountReason: 'Repeat client',
  options: doc.options.map(o => o.tier === 'standard' ? { ...o, lines: [...o.lines, { key: null, kind: 'discount' as const, label: 'Discount', qty: 1, unit: -amount, amount: 0, tbc: false, note: null }] } : o),
})

test('desk: recalc matches the engine and keeps one recommended option', () => {
  const result = homes({ reel: 1 })
  const doc = formDoc()
  assert.deepEqual(doc.options.map(o => o.total), result.options.map(o => o.total))
  assert.deepEqual(doc.options.map(o => o.deposit), result.options.map(o => o.deposit))
  assert.deepEqual(doc.options.map(o => o.selected), [false, true, false])
  const none = recalc({ ...doc, options: doc.options.map(o => ({ ...o, selected: false })) })
  assert.equal(none.options.find(o => o.selected)?.tier, 'standard', 'falls back to Standard')
  const vat = recalc({ ...doc, vatCharged: true })
  const std = vat.options[1]
  assert.equal(std.vat, Math.round(std.net * 0.16))
  assert.equal(std.total, std.net + std.vat)
  assert.ok(Number.isInteger(std.deposit))
  // amount is always qty × unit, whatever the caller sent
  const lied = recalc({ ...doc, options: [{ ...doc.options[1], lines: [{ ...doc.options[1].lines[0], qty: 2, amount: 1 }] }] })
  assert.equal(lied.options[0].lines[0].amount, 2 * doc.options[1].lines[0].unit)
})

test('desk: discounts the rate table gave are not counted against a sales limit', () => {
  // 10-property agent pack: the engine itself gives a pack discount
  const pack = price(modules.homes, { clientType: 'agent', details: { size: '2br', purpose: 'let', listings: 10 }, location: { town: 'Nairobi' } }, rateTableV1)
  const doc = docFromEngine(pack, { requestId: 'r', leadId: 'l', version: 1, depositBp: 5000, validUntil: null, status: 'sent' })
  assert.ok(doc.options[1].discountBp > 0, 'engine discount present')
  const check = checkDoc(doc, { ...ctx, discountLimitBp: 0 })
  assert.equal(check.staffDiscountBp, 0)
  assert.equal(check.needsApproval, false)
  assert.deepEqual(check.errors, [])
})

test('desk: over the limit needs approval, over the cap needs an admin, and a reason is required', () => {
  const doc = formDoc()
  const subtotal = doc.options[1].subtotal
  const small = withDiscount(doc, Math.floor(subtotal * 0.04))
  assert.equal(checkDoc(small, ctx).needsApproval, false)
  const over = withDiscount(doc, Math.floor(subtotal * 0.1))
  const r = checkDoc(over, ctx)
  assert.equal(r.needsApproval, true)
  assert.deepEqual(r.approvalReasons.map(x => x.code), ['over_limit'])
  const huge = withDiscount(doc, Math.floor(subtotal * 0.3))
  assert.deepEqual(checkDoc(huge, ctx).approvalReasons.map(x => x.code), ['over_cap', 'over_limit'])
  assert.equal(checkDoc(huge, { ...ctx, role: 'admin' }).needsApproval, false, 'an admin can go over the cap')
  assert.deepEqual(checkDoc({ ...small, discountReason: '  ' }, ctx).errors.map(e => e.code), ['discount_reason_required'])
})

test('desk: sales cannot lower a rate-table price, but can add their own lines', () => {
  const doc = formDoc()
  const cut = recalc({ ...doc, options: doc.options.map(o => ({ ...o, lines: o.lines.map(l => l.kind === 'base' ? { ...l, unit: l.unit - 1000 } : l) })) })
  assert.ok(checkDoc(cut, ctx).errors.some(e => e.code === 'price_cut_needs_admin'))
  assert.deepEqual(checkDoc(cut, { ...ctx, role: 'admin' }).errors, [])
  // an added rate line priced below the list price is caught too
  const added = recalc({ ...doc, options: doc.options.map(o => ({ ...o, lines: [...o.lines, { key: 'photos_20', kind: 'addon' as const, label: '20 photos', qty: 1, unit: 1, amount: 0, tbc: false, note: null }] })) })
  assert.ok(checkDoc(added, { ...ctx, listPrice: () => 4000 }).errors.some(e => e.code === 'price_cut_needs_admin'))
  const own = recalc({ ...doc, options: doc.options.map(o => ({ ...o, lines: [...o.lines, { key: null, kind: 'addon' as const, label: 'Drone shots', qty: 1, unit: 5000, amount: 0, tbc: false, note: null }] })) })
  assert.deepEqual(checkDoc(own, ctx).errors, [])
  const negative = recalc({ ...doc, options: [{ ...doc.options[1], lines: [{ key: null, kind: 'addon', label: 'x', qty: 1, unit: -5, amount: 0, tbc: false, note: null }] }] })
  assert.ok(checkDoc(negative, ctx).errors.some(e => e.code === 'line_sign'))
})

test('desk: a new version copies the sent one; estimates and drafts become Standard', () => {
  const sent = formDoc('sent')
  const next = nextDraft(sent, { version: 2, createdBy: SALES, validUntil: '2026-11-10' })
  assert.equal(next.id, null)
  assert.equal(next.status, 'draft')
  assert.equal(next.supersedesId, 'q1')
  assert.equal(next.createdBy, SALES)
  assert.equal(next.sentAt, null)
  assert.deepEqual(next.options.map(o => o.total), sent.options.map(o => o.total))
  const custom = { ...formDoc('draft'), options: [{ ...formDoc().options[1], tier: 'draft' as const }], baseline: { draft: { discountBp: 0, units: {} } } }
  const firm = firmTiers(custom)
  assert.equal(firm.options[0].tier, 'standard')
  assert.ok(firm.baseline.standard)
})

test('desk: send blockers, quiet hours, link expiry and money format', () => {
  const doc = formDoc('draft')
  assert.equal(sendBlocker(doc, '2026-10-28', false), null)
  assert.equal(sendBlocker(doc, '2026-10-28', true), 'opted_out')
  assert.equal(sendBlocker({ ...doc, status: 'needs_approval' }, '2026-10-28', false), 'needs_approval')
  assert.equal(sendBlocker({ ...doc, status: 'lost' }, '2026-10-28', false), 'locked')
  assert.equal(sendBlocker(doc, '2026-12-01', false), 'validity_past')
  const tbc = { ...doc, options: doc.options.map(o => ({ ...o, lines: o.lines.map((l, i) => (i === 0 ? { ...l, tbc: true } : l)) })) }
  assert.equal(sendBlocker(tbc, '2026-10-28', false), 'tbc_lines')
  // 07:00-21:00 EAT is UTC+3
  assert.equal(inQuietHours(new Date('2026-10-28T03:59:00Z')), true)    // 06:59
  assert.equal(inQuietHours(new Date('2026-10-28T04:00:00Z')), false)   // 07:00
  assert.equal(inQuietHours(new Date('2026-10-28T17:59:00Z')), false)   // 20:59
  assert.equal(inQuietHours(new Date('2026-10-28T18:00:00Z')), true)    // 21:00
  assert.equal(nairobiDate(new Date('2026-10-28T22:30:00Z')), '2026-10-29', 'after 21:00 UTC it is tomorrow in Nairobi')
  const exp = Date.parse(linkExpiry('2026-11-04', new Date('2026-10-28T09:00:00Z')))
  assert.equal(new Date(exp).toISOString(), '2026-12-04T21:00:00.000Z', '30 days after the price expires')
  assert.equal(formatKes(-7020), '−KES 7,020')
  assert.equal(formatKes(1234567), 'KES 1,234,567')
  assert.equal(formatKes(12345, 'USD'), 'USD 123.45')
})

test('rates: usage, diff and example prices', () => {
  const usage = itemUsage(modules, rateTableV1)
  assert.ok(usage.home_2br.includes('homes'))
  assert.ok(usage.min_home.includes('homes'))
  assert.deepEqual(usage[Object.values(rateTableV1.items).find(i => i.category === 'travel')!.key], ['all'])
  const next = structuredClone(rateTableV1)
  next.items.home_2br = { ...next.items.home_2br, low: 7500, high: 7500 }
  next.settings.depositBp = 4000
  const diff = diffTables(rateTableV1, next, usage)
  assert.deepEqual(diff.items.map(i => i.key), ['home_2br'])
  assert.equal(diff.items[0].after?.low, 7500)
  assert.deepEqual(diff.settings, [{ field: 'depositBp', before: 5000, after: 4000 }])
  const ex = examplePrices(modules, rateTableV1, next)
  const two = ex.find(e => e.label.includes('2 bedrooms') && e.module === 'homes')!
  assert.equal(two.after! - two.before!, 500)
  assert.ok(ex.every(e => e.before !== e.after))
})

test('pdf: renders a real PDF with the quote in it', async () => {
  const pdf = await renderQuotePdf({
    state: 'open', ref: 'Q-ABCDEF12-2', version: 2, firstName: 'Amina', industry: 'Homes and real estate',
    sentAt: '2026-10-28T09:00:00Z', validUntil: '2026-11-04', currency: 'KES', vatCharged: true, vatRateBp: 1600, depositBp: 5000,
    clientNote: 'Includes the reel.',
    options: formDoc().options.map(o => ({ tier: o.tier, recommended: o.selected, lines: o.lines, subtotal: o.subtotal, discount: o.discount, net: o.net, vat: o.vat, total: o.total, deposit: o.deposit })),
  }, { whatsapp: '254700000000' })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length > 5000)
})

// ── Routes ──────────────────────────────────────────────────────────────────

const quoteTemplates = {
  'quote_link:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, your quote for {{industry}}: {{quote_link}} {{amount}} until {{valid_until}}. {{staff_name}}' },
  'quote_link:email': { version: 1, subject: 'Your Viewora quote: {{amount}}', body: 'Hi {{name}}, {{quote_link}}' },
}

async function setup(opts: { at?: string; messagesLive?: boolean; sendFails?: boolean; templates?: Record<string, any> } = {}) {
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, templates: opts.templates ?? quoteTemplates,
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: 'peter@example.com', active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  let clock = new Date(opts.at ?? '2026-10-28T09:00:00Z')   // 12:00 in Nairobi
  let n = 0
  const tokens: string[] = []
  const emails: any[] = []
  const views: Array<[string, boolean]> = []
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, alerts: { liveSend: false, extraRecipients: [], adminUrl: '', send: async () => {} } })
  // the public routes are registered inside quoteRoutes; give them the test clock too
  await fastify.register(async f => {
    const { default: quotePublicRoutes } = await import('../routes/quotePublic.js')
    await f.register(quotePublicRoutes, { desk, now: () => clock, whatsappNumber: '254700000000', onViewed: (id, first) => views.push([id, first]) })
  }, { prefix: '/t' })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, adminStore: memoryAdminStore(() => store.dump()),
    messagesLive: opts.messagesLive ?? false, publicUrl: 'https://app.example.com', whatsappNumber: '254700000000',
    now: () => clock,
    newToken: () => { const t = crypto.createHash('sha256').update(String(n++)).digest('base64url').slice(0, 43); tokens.push(t); return t },
    sendEmail: async (m: any) => { if (opts.sendFails) throw new Error('Resend down'); emails.push(m); return 'id' },
  })
  const call = (method: string, url: string, who = ADMIN, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers: as(who), ...(payload !== undefined ? { payload: payload as any } : {}) })
  return { fastify, store, desk, call, tokens, emails, views, setClock: (iso: string) => { clock = new Date(iso) } }
}

async function lead(fastify: any, opts: { finish?: boolean; email?: string; moduleKey?: string; phone?: string } = {}) {
  const start = await fastify.inject({ method: 'POST', url: '/quote/requests', payload: { moduleKey: opts.moduleKey ?? 'homes', entry: { source: 'instagram' } } })
  const token = start.json().token
  const patch = (payload: object) => fastify.inject({ method: 'PATCH', url: `/quote/requests/${token}`, payload })
  const c = await patch({ step: 'contact', clientType: 'owner', firstName: 'Amina', whatsapp: opts.phone ?? '0712 345 678', email: opts.email ?? '', consent: true, consentTextId: 'c1' })
  assert.equal(c.statusCode, 200, c.body)
  if (opts.finish !== false) {
    if ((opts.moduleKey ?? 'homes') === 'homes') await patch({ step: 'details', details: { size: '2br', purpose: 'let' } })
    else await patch({ step: 'details', details: { description: 'Rooftop bar', setting: 'both', areas: 9, floors: 2 } })
    await patch({ step: 'extras', addons: { reel: 1 } })
    await patch({ step: 'where', location: { town: 'Kilimani, Nairobi' }, timing: 'this_month' })
  }
}

const leadId = async (call: any) => (await call('GET', '/admin/quote/leads')).json().rows[0].leadId
const editable = (q: QuoteDoc) => ({
  vatCharged: q.vatCharged, depositBp: q.depositBp, validUntil: q.validUntil, discountReason: q.discountReason, clientNote: q.clientNote,
  options: q.options.map(o => ({ tier: o.tier, selected: o.selected, lines: o.lines.map(l => ({ key: l.key, kind: l.kind, label: l.label, qty: l.qty, unit: l.unit, tbc: l.tbc, note: l.note })) })),
})
const addDiscount = (body: ReturnType<typeof editable>, amount: number, reason = 'Repeat client') => ({
  ...body, discountReason: reason,
  options: body.options.map(o => (o.tier === 'standard' ? { ...o, lines: [...o.lines, { key: null, kind: 'discount' as const, label: 'Discount', qty: 1, unit: -amount, tbc: false, note: null }] } : o)),
})

test('desk routes: roles are checked on every write', async () => {
  const { fastify, call } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  assert.equal((await call('POST', `/admin/quote/leads/${id}/quotes`, NOBODY, {})).statusCode, 403, 'no staff row: read only')
  assert.equal((await call('PATCH', `/admin/quote/leads/${id}`, NOBODY, { stage: 'contacted' })).statusCode, 403)
  assert.equal((await call('POST', `/admin/quote/leads/${id}/notes`, NOBODY, { body: 'x' })).statusCode, 403)
  assert.equal((await call('GET', '/admin/quote/board', NOBODY)).statusCode, 200, 'viewers can read the board')
  const q = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/approve`, SALES, { reason: 'ok fine' })).statusCode, 403, 'sales cannot approve')
  assert.equal((await call('POST', '/admin/quote/rate-tables/drafts', SALES, { fromId: rateTableV1.id })).statusCode, 403, 'sales cannot edit prices')
  assert.equal((await call('GET', '/admin/quote/rate-tables', NOBODY)).statusCode, 200)
  assert.equal((await fastify.inject({ method: 'GET', url: '/admin/quote/board' })).statusCode, 401)
  assert.deepEqual((await call('GET', '/admin/quote/staff', SALES)).json().me, { id: SALES, name: 'Wanjiru', role: 'sales', discountLimitBp: 500 })
  assert.equal((await call('GET', '/admin/quote/staff', NOBODY)).json().me.role, 'viewer')
})

test('desk routes: New to Quoted — create, edit, send a link, the client opens it', async () => {
  const { fastify, call, store, tokens, views } = await setup()
  await lead(fastify)
  const id = await leadId(call)

  // The visitor saw version 1; staff start version 2 from it
  const created = await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})
  assert.equal(created.statusCode, 201)
  const quoteId = created.json().id
  const again = await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})
  assert.deepEqual(again.json(), { id: quoteId, created: false }, 'an open draft is reused')

  const editor = (await call('GET', `/admin/quote/quotes/${quoteId}`, SALES)).json()
  assert.equal(editor.quote.version, 2)
  assert.equal(editor.quote.status, 'draft')
  assert.equal(editor.quote.supersedesId, store.dump().quotes[0].id)
  assert.equal(editor.lead.firstName, 'Amina')
  assert.equal(editor.industry, 'Homes and real estate')
  assert.ok(editor.answers.find((a: any) => a.label === 'What size is the home?'))
  assert.ok(editor.catalogue.find((c: any) => c.key === 'video'))
  assert.equal(editor.me.role, 'sales')
  assert.equal(editor.sendBlocker, null)
  assert.deepEqual(editor.versions.map((v: any) => v.version), [2, 1])

  // Edit in place: a hand-typed line and a note for the client
  const body = editable(editor.quote)
  body.clientNote = 'Includes the reel you asked for.'
  body.options[1].lines.push({ key: null, kind: 'addon', label: 'Drone shots', qty: 1, unit: 6000, tbc: false, note: null })
  const saved = await call('PUT', `/admin/quote/quotes/${quoteId}`, SALES, body)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual({ id: saved.json().id, created: saved.json().created, status: saved.json().status }, { id: quoteId, created: false, status: 'draft' })
  const afterEdit = (await call('GET', `/admin/quote/quotes/${quoteId}`, SALES)).json().quote
  assert.equal(afterEdit.options[1].total, editor.quote.options[1].total + 6000)

  // Send as a link: the lead moves to Quoted, only the hash is stored
  const sent = await call('POST', `/admin/quote/quotes/${quoteId}/send`, SALES, { channel: 'link' })
  assert.equal(sent.statusCode, 200, sent.body)
  assert.equal(sent.json().url, `https://app.example.com/quote/view/${tokens[0]}`)
  const d = store.dump()
  assert.equal(d.leads[0].stage, 'quoted')
  assert.equal(d.quotes.find(q => q.id === quoteId)!.status, 'sent')
  assert.equal(d.quotes[0].status, 'superseded', "the form's version is replaced")
  assert.equal(d.links[0].tokenHash, crypto.createHash('sha256').update(tokens[0]).digest('hex'))
  assert.ok(!JSON.stringify(d).includes(tokens[0]), 'the raw token is stored nowhere')

  // The client opens it: GET does not count, POST /seen does
  const page = await fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}` })
  assert.equal(page.statusCode, 200)
  assert.equal(page.headers['cache-control'], 'no-store')
  const view = page.json().quote
  assert.equal(view.state, 'open')
  assert.equal(view.firstName, 'Amina')
  assert.equal(view.clientNote, 'Includes the reel you asked for.')
  assert.equal(view.options[1].total, afterEdit.options[1].total)
  assert.ok(!('whatsapp' in view) && !JSON.stringify(view).includes('+254'), 'no contact details on the page')
  assert.ok(!JSON.stringify(view).includes('rateItemKey') && view.options[0].lines[0].key === undefined, 'no rate keys')
  assert.equal(store.dump().quotes.find(q => q.id === quoteId)!.status, 'sent', 'a link preview does not count as viewed')
  assert.equal((await fastify.inject({ method: 'POST', url: `/t/view/${tokens[0]}/seen` })).statusCode, 204)
  await fastify.inject({ method: 'POST', url: `/t/view/${tokens[0]}/seen` })
  assert.equal(store.dump().quotes.find(q => q.id === quoteId)!.status, 'viewed')
  assert.equal(store.dump().links[0].views, 2)
  assert.deepEqual(views, [[quoteId, true], [quoteId, false]])

  // PDF
  const pdf = await fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}/pdf` })
  assert.equal(pdf.statusCode, 200)
  assert.equal(pdf.headers['content-type'], 'application/pdf')
  assert.match(String(pdf.headers['content-disposition']), /Viewora-quote-Q-[0-9A-F]{8}-2\.pdf/)
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-')

  // Unknown and malformed links
  assert.equal((await fastify.inject({ method: 'GET', url: `/t/view/${'x'.repeat(43)}` })).statusCode, 404)
  assert.equal((await fastify.inject({ method: 'GET', url: '/t/view/short' })).statusCode, 400)

  // The lead page shows the history
  const detail = (await call('GET', `/admin/quote/leads/${id}`)).json()
  assert.deepEqual(detail.requests[0].quotes.map((q: any) => [q.version, q.status]), [[2, 'viewed'], [1, 'superseded']])
  assert.equal(detail.requests[0].quotes[0].createdByName, 'Wanjiru')
  assert.equal(detail.requests[0].quotes[0].links.views, 2)
  const actions = detail.activity.map((a: any) => a.action)
  for (const a of ['created', 'edited', 'sent_link', 'stage_changed']) assert.ok(actions.includes(a), a)
})

test('desk routes: editing a sent quote makes a new version; the old link says it was replaced', async () => {
  const { fastify, call, tokens, store } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  const v2 = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  await call('POST', `/admin/quote/quotes/${v2}/send`, SALES, { channel: 'link' })
  const editor = (await call('GET', `/admin/quote/quotes/${v2}`, SALES)).json()
  assert.equal(editor.newVersionOnSave, true)
  const res = await call('PUT', `/admin/quote/quotes/${v2}`, SALES, { ...editable(editor.quote), clientNote: 'Updated' })
  assert.equal(res.json().created, true)
  const v3 = res.json().id
  assert.notEqual(v3, v2)
  assert.equal(store.dump().quotes.find(q => q.id === v2)!.clientNote, null, 'the sent copy never changes')
  // Until v3 is sent, the client still sees v2
  assert.equal((await fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}` })).json().quote.state, 'open')
  await call('POST', `/admin/quote/quotes/${v3}/send`, SALES, { channel: 'link' })
  const old = (await fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}` })).json().quote
  assert.equal(old.state, 'replaced')
  assert.ok(old.replacedAt)
  assert.equal(old.options, undefined, 'no old prices on a replaced link')
  assert.equal((await fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}/pdf` })).statusCode, 410)
  assert.equal((await fastify.inject({ method: 'GET', url: `/t/view/${tokens[1]}` })).json().quote.version, 3)
})

test('desk routes: a discount over the limit waits for an admin', async () => {
  const { fastify, call, store } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  const q = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  const editor = (await call('GET', `/admin/quote/quotes/${q}`, SALES)).json()
  const subtotal = editor.quote.options[1].subtotal

  const noReason = await call('PUT', `/admin/quote/quotes/${q}`, SALES, addDiscount(editable(editor.quote), 2000, ''))
  assert.equal(noReason.statusCode, 422)
  assert.deepEqual(noReason.json().errors.map((e: any) => e.code), ['discount_reason_required'])

  const big = await call('PUT', `/admin/quote/quotes/${q}`, SALES, addDiscount(editable(editor.quote), Math.round(subtotal * 0.1)))
  assert.equal(big.json().status, 'needs_approval')
  assert.deepEqual(big.json().approvalReasons.map((r: any) => r.code), ['over_limit'])
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'link' })).json().code, 'NEEDS_APPROVAL')
  const board = (await call('GET', '/admin/quote/board')).json()
  assert.equal(board.columns.find((c: any) => c.stage === 'new').rows[0].needsApproval, true)

  assert.equal((await call('POST', `/admin/quote/quotes/${q}/approve`, ADMIN, { reason: 'Second listing this month' })).statusCode, 200)
  assert.equal(store.dump().quotes.find(x => x.id === q)!.discountApprovedBy, ADMIN)
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/approve`, ADMIN, { reason: 'again' })).json().code, 'NOT_WAITING')

  // Saving again without changing the discount keeps the approval
  const approved = (await call('GET', `/admin/quote/quotes/${q}`, SALES)).json().quote
  const keep = await call('PUT', `/admin/quote/quotes/${q}`, SALES, { ...editable(approved), clientNote: 'See you Saturday' })
  assert.equal(keep.json().status, 'draft')
  assert.equal(store.dump().quotes.find(x => x.id === q)!.discountApprovedBy, ADMIN)
  // Raising it needs approval again
  const more = await call('PUT', `/admin/quote/quotes/${q}`, SALES, addDiscount(editable(approved), 500))
  assert.equal(more.json().status, 'needs_approval')
  await call('POST', `/admin/quote/quotes/${q}/reject`, ADMIN, { reason: 'Too much for one unit' })
  const rejected = store.dump().quotes.find(x => x.id === q)!
  assert.equal(rejected.status, 'draft')
  assert.equal(rejected.discountApprovedBy, null)
  assert.ok(store.dump().audit.some(a => a.action === 'discount_rejected' && a.reason === 'Too much for one unit'))

  // Sales cannot lower a rate-table price
  const cut = editable(approved)
  cut.options[1].lines[0].unit -= 1000
  const cutRes = await call('PUT', `/admin/quote/quotes/${q}`, SALES, cut)
  assert.equal(cutRes.statusCode, 422)
  assert.ok(cutRes.json().errors.some((e: any) => e.code === 'price_cut_needs_admin'))
  // An admin's own discount is approved by them
  const adminSave = await call('PUT', `/admin/quote/quotes/${q}`, ADMIN, addDiscount(editable(approved), Math.round(subtotal * 0.3), 'Launch partner'))
  assert.equal(adminSave.json().status, 'draft')
  assert.equal(store.dump().quotes.find(x => x.id === q)!.discountApprovedBy, ADMIN)
})

test('desk routes: check says what a save would do, and saves nothing', async () => {
  const { fastify, call, store } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  const q = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  const editor = (await call('GET', `/admin/quote/quotes/${q}`, SALES)).json()
  const before = JSON.stringify(store.dump().quotes)
  const subtotal = editor.quote.options[1].subtotal

  const ok = (await call('POST', `/admin/quote/quotes/${q}/check`, SALES, editable(editor.quote))).json()
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.needsApproval, false)
  assert.deepEqual(ok.options.map((o: any) => o.total), editor.quote.options.map((o: any) => o.total))

  const big = (await call('POST', `/admin/quote/quotes/${q}/check`, SALES, addDiscount(editable(editor.quote), Math.round(subtotal * 0.1)))).json()
  assert.equal(big.needsApproval, true)
  assert.deepEqual(big.approvalReasons.map((r: any) => r.code), ['over_limit'])
  assert.equal(big.options[1].total, editor.quote.options[1].total - Math.round(subtotal * 0.1))
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/check`, ADMIN, addDiscount(editable(editor.quote), Math.round(subtotal * 0.1)))).json().needsApproval, false, 'admins approve their own')

  const bad = (await call('POST', `/admin/quote/quotes/${q}/check`, SALES, { ...addDiscount(editable(editor.quote), 500, ''), validUntil: '2020-01-01' })).json()
  assert.deepEqual(bad.errors.map((e: any) => e.code), ['discount_reason_required', 'validity_range'])
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/check`, NOBODY, editable(editor.quote))).statusCode, 403)
  assert.equal(JSON.stringify(store.dump().quotes), before, 'nothing saved')
})

test('desk routes: input is validated', async () => {
  const { fastify, call } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  const q = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  const good = editable((await call('GET', `/admin/quote/quotes/${q}`, SALES)).json().quote)
  const bad = async (body: unknown) => (await call('PUT', `/admin/quote/quotes/${q}`, SALES, body)).statusCode
  assert.equal(await bad({ ...good, depositBp: 10_001 }), 400)
  assert.equal(await bad({ ...good, options: [] }), 400)
  assert.equal(await bad({ ...good, options: [good.options[1], good.options[1]] }), 400, 'duplicate tiers')
  assert.equal(await bad({ ...good, options: [{ ...good.options[1], lines: [{ ...good.options[1].lines[0], qty: 1.5 }] }] }), 400, 'no fractional quantities')
  assert.equal(await bad({ ...good, options: [{ ...good.options[1], lines: [{ ...good.options[1].lines[0], unit: 99.9 }] }] }), 400, 'money is whole shillings')
  assert.equal(await bad({ ...good, validUntil: '2026-10-01' }), 422, 'validity in the past')
  assert.equal(await bad({ ...good, validUntil: '2027-12-01' }), 422, 'validity too far')
  assert.equal(await bad({ ...good, options: [{ ...good.options[1], lines: [{ ...good.options[1].lines[0], label: '' }] }] }), 400)
  // HTML in labels is cleaned
  const html = { ...good, options: [{ ...good.options[1], lines: [{ ...good.options[1].lines[0], label: '<b>Tour</b><script>x</script>' }] }] }
  assert.equal(await bad(html), 200)
  const label = (await call('GET', `/admin/quote/quotes/${q}`, SALES)).json().quote.options[0].lines[0].label
  assert.ok(!/[<>]/.test(label), label)
  assert.equal((await call('GET', '/admin/quote/quotes/not-a-uuid')).statusCode, 400)
  assert.equal((await call('GET', '/admin/quote/quotes/00000000-0000-4000-8000-00000000dead')).statusCode, 404)
})

test('desk routes: WhatsApp gives a click-to-chat link; email stays in sandbox', async () => {
  const { fastify, call, store, emails } = await setup()
  await lead(fastify, { email: 'amina@example.com' })
  const id = await leadId(call)
  const q = (await call('POST', `/admin/quote/leads/${id}/quotes`, SALES, {})).json().id
  const wa = (await call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'whatsapp' })).json()
  assert.match(wa.waUrl, /^https:\/\/wa\.me\/254712345678\?text=/)
  const text = decodeURIComponent(wa.waUrl.split('text=')[1])
  assert.match(text, /^Hi Amina, your quote for Homes and real estate: https:\/\/app\.example\.com\/quote\/view\/[A-Za-z0-9_-]{43} KES [\d,]+ until \d+ November 2026\. Wanjiru$/)
  const email = (await call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'email' })).json()
  assert.deepEqual(email.email, { status: 'skipped', skipReason: 'sandbox' })
  assert.equal(email.sandbox, true)
  assert.equal(emails.length, 0, 'nothing sent in sandbox')
  const msgs = store.dump().messages.filter(m => m.templateKey === 'quote_link')
  assert.deepEqual(msgs.map(m => [m.channel, m.status, m.skipReason]), [['whatsapp', 'sent', 'click_to_chat'], ['email', 'skipped', 'sandbox']])
  assert.ok(msgs.every(m => m.quoteId === q))
  assert.equal(store.dump().links.length, 2, 'each send makes its own link')
})

test('desk routes: live email attaches the PDF; a failure is recorded and the link still works', async () => {
  const live = await setup({ messagesLive: true })
  await lead(live.fastify, { email: 'amina@example.com' })
  const q = (await live.call('POST', `/admin/quote/leads/${await leadId(live.call)}/quotes`, SALES, {})).json().id
  const res = (await live.call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'email' })).json()
  assert.deepEqual(res.email, { status: 'sent' })
  assert.deepEqual(live.emails[0].to, ['amina@example.com'])
  assert.match(live.emails[0].subject, /^Your Viewora quote: KES [\d,]+$/)
  assert.equal(live.emails[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-')

  const failing = await setup({ messagesLive: true, sendFails: true })
  await lead(failing.fastify, { email: 'amina@example.com' })
  const fq = (await failing.call('POST', `/admin/quote/leads/${await leadId(failing.call)}/quotes`, SALES, {})).json().id
  const fr = (await failing.call('POST', `/admin/quote/quotes/${fq}/send`, SALES, { channel: 'email' })).json()
  assert.equal(fr.email.status, 'failed')
  assert.ok(fr.url)
  assert.equal(failing.store.dump().messages.at(-1)!.status, 'failed')
  assert.equal(failing.store.dump().messages.at(-1)!.error, 'Resend down')
})

test('desk routes: quiet hours, opted-out leads, no email, missing wording', async () => {
  const night = await setup({ at: '2026-10-28T19:30:00Z' })   // 22:30 in Nairobi
  await lead(night.fastify, { email: 'amina@example.com' })
  const nightLead = await leadId(night.call)
  const q = (await night.call('POST', `/admin/quote/leads/${nightLead}/quotes`, SALES, {})).json().id
  assert.equal((await night.call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'whatsapp' })).json().code, 'QUIET_HOURS')
  assert.equal((await night.call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'email' })).json().code, 'QUIET_HOURS')
  assert.equal((await night.call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'link' })).statusCode, 200, 'copying a link is fine at night')
  assert.equal((await night.call('GET', `/admin/quote/quotes/${q}`, SALES)).json().quietHours, true)

  const day = await setup({ templates: {} })
  await lead(day.fastify)
  const dq = (await day.call('POST', `/admin/quote/leads/${await leadId(day.call)}/quotes`, SALES, {})).json().id
  assert.equal((await day.call('POST', `/admin/quote/quotes/${dq}/send`, SALES, { channel: 'email' })).json().code, 'NO_EMAIL')
  assert.equal((await day.call('POST', `/admin/quote/quotes/${dq}/send`, SALES, { channel: 'whatsapp' })).json().code, 'TEMPLATE_MISSING')
  assert.equal(day.store.dump().links.length, 0, 'nothing is marked sent when the wording is missing')
  day.store.dump().leads[0].optedOutAt = new Date().toISOString()
  assert.equal((await day.call('POST', `/admin/quote/quotes/${dq}/send`, SALES, { channel: 'link' })).json().code, 'OPTED_OUT')
})

test('desk routes: expired price, expired link and lost quote', async () => {
  const { fastify, call, tokens, setClock } = await setup()
  await lead(fastify)
  const q = (await call('POST', `/admin/quote/leads/${await leadId(call)}/quotes`, SALES, {})).json().id
  await call('POST', `/admin/quote/quotes/${q}/send`, SALES, { channel: 'link' })
  const view = (iso: string) => { setClock(iso); return fastify.inject({ method: 'GET', url: `/t/view/${tokens[0]}` }).then(r => r.json().quote) }
  assert.equal((await view('2026-11-10T09:00:00Z')).state, 'expired', 'after the valid-until date')
  assert.ok((await view('2026-11-10T09:00:00Z')).options, 'expired prices are still shown, marked expired')
  assert.equal((await view('2027-01-10T09:00:00Z')).state, 'gone', 'link expires a month later')
  assert.equal((await view('2027-01-10T09:00:00Z')).options, undefined)
  setClock('2026-10-28T09:00:00Z')
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/lost`, SALES, { reason: 'Chose someone else' })).statusCode, 200)
  assert.equal((await view('2026-10-28T09:00:00Z')).state, 'closed')
  assert.equal((await call('POST', `/admin/quote/quotes/${q}/lost`, SALES, { reason: 'again' })).json().code, 'LOCKED')
})

test('desk routes: a hand-priced lead gets a Standard draft staff can price', async () => {
  const { fastify, call } = await setup()
  await lead(fastify, { moduleKey: 'other' })
  const q = (await call('POST', `/admin/quote/leads/${await leadId(call)}/quotes`, SALES, {})).json().id
  const e = (await call('GET', `/admin/quote/quotes/${q}`, SALES)).json()
  assert.equal(e.quote.version, 1, "the form's own draft is the one staff price")
  assert.deepEqual(e.quote.options.map((o: any) => o.tier), ['standard'], 'shown as a firm Standard option')
  assert.ok(e.quote.options[0].total >= 7000)

  // A lead that stopped before pricing gets a blank draft
  await lead(fastify, { finish: false, phone: '0722 000 111' })
  const rows = (await call('GET', '/admin/quote/leads')).json().rows
  const early = rows.find((r: any) => r.whatsapp === '+254722000111').leadId
  const b = (await call('POST', `/admin/quote/leads/${early}/quotes`, SALES, {})).json().id
  const blank = (await call('GET', `/admin/quote/quotes/${b}`, SALES)).json()
  assert.equal(blank.quote.options[0].lines.length, 0)
  assert.equal(blank.sendBlocker, 'no_lines')
})

test('desk routes: board, stage, owner and notes', async () => {
  const { fastify, call, store } = await setup()
  await lead(fastify)
  const id = await leadId(call)
  let board = (await call('GET', '/admin/quote/board')).json()
  assert.deepEqual(board.columns.map((c: any) => c.stage), ['new', 'contacted', 'quoted', 'booked', 'delivered', 'paid', 'lost'])
  assert.equal(board.columns[0].total, 1)

  assert.equal((await call('PATCH', `/admin/quote/leads/${id}`, SALES, { stage: 'contacted', ownerId: SALES })).statusCode, 200)
  board = (await call('GET', `/admin/quote/board?owner=${SALES}`)).json()
  assert.equal(board.columns[1].rows[0].ownerName, 'Wanjiru')
  assert.equal((await call('GET', '/admin/quote/board?owner=none')).json().columns[1].total, 0)
  assert.equal((await call('PATCH', `/admin/quote/leads/${id}`, SALES, { ownerId: NOBODY })).json().code, 'OWNER_NOT_STAFF')
  assert.equal((await call('PATCH', `/admin/quote/leads/${id}`, SALES, {})).statusCode, 400)
  assert.equal((await call('PATCH', `/admin/quote/leads/${id}`, SALES, { stage: 'won' })).statusCode, 400)

  assert.equal((await call('POST', `/admin/quote/leads/${id}/notes`, SALES, { body: 'Called, wants Saturday <b>morning</b>' })).statusCode, 201)
  assert.equal((await call('POST', `/admin/quote/leads/${id}/notes`, SALES, { body: '   ' })).statusCode, 400)
  const detail = (await call('GET', `/admin/quote/leads/${id}`)).json()
  assert.equal(detail.notes[0].authorName, 'Wanjiru')
  assert.ok(!detail.notes[0].body.includes('<b>'))
  assert.equal(detail.lead.ownerName, 'Wanjiru')
  assert.deepEqual(detail.activity.map((a: any) => a.action).sort(), ['owner_changed', 'stage_changed'])
  assert.deepEqual((await call('GET', '/admin/quote/staff')).json().staff.map((s: any) => s.name), ['Peter', 'Wanjiru'])
  assert.equal(store.dump().leads[0].stage, 'contacted')
})

test('rate routes: draft, edit, preview the impact, publish, roll back', async () => {
  const { fastify, call, store } = await setup()
  await lead(fastify)
  const list = (await call('GET', '/admin/quote/rate-tables')).json().tables
  assert.deepEqual(list.map((t: any) => [t.version, t.status]), [[1, 'published']])
  const live = (await call('GET', `/admin/quote/rate-tables/${list[0].id}`, SALES)).json()
  assert.equal(live.canEdit, false)
  assert.ok(live.items.find((i: any) => i.key === 'home_2br').usedBy.includes('homes'))
  assert.equal(live.openQuotes, 1, "the visitor's quote is still open")

  const draft = await call('POST', '/admin/quote/rate-tables/drafts', ADMIN, { fromId: list[0].id })
  assert.equal(draft.statusCode, 201)
  const draftId = draft.json().id
  assert.equal((await call('POST', '/admin/quote/rate-tables/drafts', ADMIN, { fromId: list[0].id })).json().code, 'DRAFT_EXISTS')
  assert.equal((await call('GET', `/admin/quote/rate-tables/${draftId}`)).json().canEdit, true)

  const patch = (key: string, body: object) => call('PATCH', `/admin/quote/rate-tables/${draftId}/items/${key}`, ADMIN, body)
  assert.equal((await patch('home_2br', { low: 7500, high: 7500 })).statusCode, 200)
  assert.equal((await patch('home_2br', { low: 9000, high: 8000 })).json().code, 'HIGH_BELOW_LOW')
  assert.equal((await patch('home_2br', { low: 75.5 })).statusCode, 400, 'whole shillings only')
  assert.equal((await patch('nope', { low: 1 })).statusCode, 404)
  assert.equal((await call('PATCH', `/admin/quote/rate-tables/${list[0].id}/items/home_2br`, ADMIN, { low: 1 })).json().code, 'NOT_DRAFT', 'the live table never changes')
  const settings = { ...rateTableV1.settings, depositBp: 4000 }
  assert.equal((await call('PUT', `/admin/quote/rate-tables/${draftId}/settings`, ADMIN, settings)).statusCode, 200)
  assert.equal((await call('PUT', `/admin/quote/rate-tables/${draftId}/settings`, ADMIN, { ...settings, discountCapBp: 20_000 })).statusCode, 400)

  const impact = (await call('GET', `/admin/quote/rate-tables/${draftId}/impact`, SALES)).json()
  assert.deepEqual(impact.items.map((i: any) => [i.key, i.before.low, i.after.low]), [['home_2br', 7000, 7500]])
  assert.deepEqual(impact.settings, [{ field: 'depositBp', before: 5000, after: 4000 }])
  assert.ok(impact.examples.some((e: any) => e.label.includes('2 bedrooms') && e.after - e.before === 500))
  assert.equal(impact.openQuotes, 1, 'the visitor’s quote keeps its price')
  assert.deepEqual(impact.problems, [])

  assert.equal((await call('POST', `/admin/quote/rate-tables/${draftId}/publish`, ADMIN, { notes: '' })).statusCode, 400, 'publishing needs a note')
  assert.equal((await call('POST', `/admin/quote/rate-tables/${draftId}/publish`, ADMIN, { notes: 'New 2-bedroom price' })).statusCode, 200)
  const config = (await fastify.inject({ method: 'GET', url: '/quote/config' })).json()
  assert.equal(config.rateTableVersion, 2, 'the form uses the new table at once')
  assert.equal(store.dump().quotes[0].rateTableVersion, 1, 'the sent quote keeps version 1')

  // A new quote uses version 2; the old quote's new version stays on version 1
  const q = (await call('POST', `/admin/quote/leads/${await leadId(call)}/quotes`, SALES, {})).json().id
  assert.equal((await call('GET', `/admin/quote/quotes/${q}`, SALES)).json().quote.rateTableVersion, 1)

  const tables = (await call('GET', '/admin/quote/rate-tables')).json().tables
  assert.deepEqual(tables.map((t: any) => [t.version, t.status, t.publishedByName]), [[2, 'published', 'Peter'], [1, 'archived', null]])
  assert.equal((await call('POST', `/admin/quote/rate-tables/${tables[0].id}/rollback`, ADMIN, { notes: 'Undo' })).json().code, 'NOT_ARCHIVED')
  const back = (await call('POST', `/admin/quote/rate-tables/${tables[1].id}/rollback`, ADMIN, { notes: 'Back to the old price' })).json()
  assert.deepEqual([back.version, back.status, back.from], [3, 'published', 1])
  assert.equal((await fastify.inject({ method: 'GET', url: '/quote/config' })).json().rateTableVersion, 3)

  // Discard a draft
  const tmp = (await call('POST', '/admin/quote/rate-tables/drafts', ADMIN, { fromId: back.id })).json().id
  assert.equal((await call('DELETE', `/admin/quote/rate-tables/${tmp}`, ADMIN)).statusCode, 204)
  assert.equal((await call('DELETE', `/admin/quote/rate-tables/${back.id}`, ADMIN)).json().code, 'NOT_DRAFT')
  assert.ok(store.dump().audit.some(a => a.entityType === 'rate_item' && a.entityId === '2:home_2br'))
})

test('rate routes: clearing a price makes that size hand-priced on the form', async () => {
  const { fastify, call } = await setup()
  const live = (await call('GET', '/admin/quote/rate-tables')).json().tables[0]
  const draftId = (await call('POST', '/admin/quote/rate-tables/drafts', ADMIN, { fromId: live.id })).json().id
  await call('PATCH', `/admin/quote/rate-tables/${draftId}/items/home_2br`, ADMIN, { low: null, high: null })
  assert.equal((await call('PATCH', `/admin/quote/rate-tables/${draftId}/items/home_2br`, ADMIN, { use: 'high' })).json().code, 'NO_HIGH')
  const impact = (await call('GET', `/admin/quote/rate-tables/${draftId}/impact`)).json()
  assert.deepEqual(impact.problems, [])
  assert.ok(impact.examples.some((e: any) => e.label.includes('2 bedrooms') && e.after === null), 'the preview shows the price going away')
  assert.equal((await call('POST', `/admin/quote/rate-tables/${draftId}/publish`, ADMIN, { notes: 'Price 2-bedrooms by hand' })).statusCode, 200)
  const config = (await fastify.inject({ method: 'GET', url: '/quote/config' })).json()
  const size = config.modules.find((m: any) => m.key === 'homes').questions.find((q: any) => q.id === 'size')
  assert.equal(size.options.find((o: any) => o.value === '2br').price, null)
})
