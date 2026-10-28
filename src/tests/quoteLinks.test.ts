import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { commissionCsv, commissionFor, hashCode, linkState, type CommissionJob } from '../quote/links.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })
const DAY = 86_400_000

// ── Pure rules ──────────────────────────────────────────────────────────────

const job = (patch: Partial<CommissionJob> = {}): CommissionJob => ({
  jobId: 'j1', jobRef: 'VJ-0001', leadId: 'l1', leadName: 'Amina', partnerId: 'p1', partnerName: 'Kilimani Agents', partnerCode: 'KILI',
  commissionType: 'percent', commissionValue: 1_000, currency: 'KES', net: 25_000, status: 'delivered',
  depositStatus: 'paid', balanceStatus: 'paid', balancePaidAt: '2026-11-10T09:00:00Z', payout: null, ...patch,
})

test('commission: owed on full payment, on the price before VAT; nothing for cancelled or refunded jobs', () => {
  assert.deepEqual([commissionFor(job()).commission, commissionFor(job()).commissionStatus], [2_500, 'owed'])
  // 10% of 25,005 is 2,500.5: rounded to whole shillings
  assert.equal(commissionFor(job({ net: 25_005 })).commission, 2_501)
  assert.equal(commissionFor(job({ balanceStatus: 'pending', balancePaidAt: null })).commissionStatus, 'waiting')
  assert.equal(commissionFor(job({ balanceStatus: 'waived' })).reason, 'Balance waived')
  assert.deepEqual([commissionFor(job({ status: 'cancelled' })).commission, commissionFor(job({ status: 'cancelled' })).commissionStatus], [0, 'none'])
  assert.equal(commissionFor(job({ depositStatus: 'refunded' })).commissionStatus, 'none')
  // A fixed fee per job, in KES; a USD job under a fixed fee is agreed by hand
  assert.equal(commissionFor(job({ commissionType: 'fixed', commissionValue: 3_000 })).commission, 3_000)
  const usd = commissionFor(job({ commissionType: 'fixed', commissionValue: 3_000, currency: 'USD' }))
  assert.deepEqual([usd.commission, usd.commissionStatus], [null, 'waiting'])
  // Paid out: the recorded amount stands, even if the terms change later
  const paid = commissionFor(job({ commissionValue: 2_000, payout: { id: 'po1', amount: 2_500, reference: 'QK12', paidAt: '2026-11-12T09:00:00Z', paidByName: 'Peter' } }))
  assert.deepEqual([paid.commission, paid.commissionStatus], [2_500, 'paid'])
})

test('commission CSV: quoted cells, and nothing a spreadsheet would run as a formula', () => {
  const csv = commissionCsv([commissionFor(job({ leadName: '=HYPERLINK("x")', partnerName: 'Kili, Agents' }))])
  const [head, row] = csv.trim().split('\n')
  assert.match(head, /^Partner,Partner code,Job,Client/)
  assert.ok(row.startsWith('"Kili, Agents",KILI,VJ-0001,"\'=HYPERLINK(""x"")",KES,25000,10%,2500,owed,2026-11-10,,'))
})

test('link state: revoked, expired and used up', () => {
  const at = new Date('2026-11-02T09:00:00Z')
  assert.equal(linkState({ revokedAt: null, expiresAt: null, uses: 5, maxUses: null }, at), 'active')
  assert.equal(linkState({ revokedAt: '2026-11-01T00:00:00Z', expiresAt: null, uses: 0, maxUses: null }, at), 'revoked')
  assert.equal(linkState({ revokedAt: null, expiresAt: '2026-11-02T09:00:00Z', uses: 0, maxUses: null }, at), 'expired')
  assert.equal(linkState({ revokedAt: null, expiresAt: null, uses: 1, maxUses: 1 }, at), 'used_up')
})

// ── Routes over the memory store ────────────────────────────────────────────

async function setup() {
  let clock = new Date('2026-11-02T09:00:00Z')
  const now = () => clock
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: null, active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const pending: Promise<unknown>[] = []
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, onAlert: p => pending.push(p), payments: { paystack: null, now } })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, followups, adminStore: memoryAdminStore(() => store.dump()),
    messagesLive: false, publicUrl: 'https://app.example.com', now, payments: { paystack: null, now },
  })
  const pub = (method: string, url: string, payload?: unknown) => fastify.inject({ method: method as any, url, ...(payload !== undefined ? { payload: payload as any } : {}) })
  const call = (method: string, url: string, who = ADMIN, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers: as(who), ...(payload !== undefined ? { payload: payload as any } : {}) })
  const later = (ms: number) => { clock = new Date(clock.getTime() + ms) }
  const settle = async () => { await Promise.all(pending.splice(0)) }

  // The visitor fills the form as far as their number
  async function visit(entry: Record<string, unknown>, phone = '0712 345 670', name = 'Wanjiku') {
    const res = await pub('POST', '/quote/requests', { moduleKey: 'homes', entry })
    assert.equal(res.statusCode, 201)
    const token = res.json().token as string
    const contact = await pub('PATCH', `/quote/requests/${token}`, { step: 'contact', clientType: 'owner', firstName: name, whatsapp: phone, email: '', consent: true, consentTextId: 'c1' })
    assert.equal(contact.statusCode, 200)
    await settle()
    const lead = store.dump().leads.find(l => l.whatsappE164 === `+254${phone.replace(/\s/g, '').slice(1)}`)!
    return { token, lead, request: store.dump().requests.find(r => r.leadId === lead.id)! }
  }
  return { store, pub, call, later, visit }
}

test('DM link: made for a named person, prefills the form, credits the maker, and only its hash is stored', async () => {
  const t = await setup()
  const made = await t.call('POST', '/admin/quote/links', SALES, { kind: 'dm', firstName: 'Wanjiku', industry: 'homes', source: 'instagram' })
  assert.equal(made.statusCode, 201)
  const { url, link } = made.json()
  const code = url.split('/q/')[1]
  assert.match(url, /^https:\/\/app\.example\.com\/q\/[A-Za-z0-9_-]{16}$/)
  assert.equal(link.code, null, 'the code is not sent back again')
  assert.equal(link.url, null)
  assert.equal(link.expiresAt, new Date(Date.parse('2026-11-02T09:00:00Z') + 30 * DAY).toISOString())
  const saved = t.store.dump().entryLinks[0]
  assert.equal(saved.key, hashCode(code))
  assert.ok(!JSON.stringify(t.store.dump()).includes(code), 'the plain code is nowhere in storage')

  // The visitor opens it: first name and industry only
  const entry = await t.pub('GET', `/quote/entry/${code}`)
  assert.equal(entry.statusCode, 200)
  assert.deepEqual(entry.json(), { kind: 'dm', prefill: { firstName: 'Wanjiku', moduleKey: 'homes' } })

  const { lead, request } = await t.visit({ code, source: 'site' })
  assert.equal(request.entry.source, 'instagram', 'the link says where the DM was')
  assert.equal(lead.source, 'instagram')
  assert.equal(lead.ownerStaffId, SALES, 'whoever made the link owns the lead')
  assert.equal(t.store.dump().entryLinks[0].leadId, lead.id)
  assert.equal(t.store.dump().entryLinks[0].uses, 1)

  // The lead page shows the link
  const attr = (await t.call('GET', `/admin/quote/leads/${lead.id}/attribution`, SALES)).json()
  assert.equal(attr.links.length, 1)
  assert.equal(attr.links[0].leadName, 'Wanjiku')
  assert.equal(attr.links[0].createdByName, 'Wanjiru')
  assert.equal(attr.partner, null)
})

test('DM link: an owner already set is kept; expired and revoked links stop prefilling and are not counted', async () => {
  const t = await setup()
  const first = await t.visit({ source: 'site' })
  first.lead.ownerStaffId = ADMIN
  const made = (await t.call('POST', '/admin/quote/links', SALES, { kind: 'dm', leadId: first.lead.id, source: 'whatsapp' })).json()
  const code = made.url.split('/q/')[1]
  assert.equal((await t.pub('GET', `/quote/entry/${code}`)).json().prefill.firstName, 'Wanjiku', 'name taken from the lead')
  await t.visit({ code })
  assert.equal(t.store.dump().leads[0].ownerStaffId, ADMIN)

  t.later(31 * DAY)
  assert.equal((await t.pub('GET', `/quote/entry/${code}`)).statusCode, 410)
  const late = await t.pub('POST', '/quote/requests', { moduleKey: 'homes', entry: { code } })
  assert.equal(late.statusCode, 201, 'the form still starts')
  assert.equal(t.store.dump().requests.at(-1)!.entry.linkKey, undefined)
  assert.equal(t.store.dump().entryLinks[0].uses, 1)

  const campaign = (await t.call('POST', '/admin/quote/links', SALES, { kind: 'campaign', code: 'sarit-walkin', label: 'Sarit poster', town: 'Westlands', source: 'qr' })).json()
  assert.equal(campaign.url, 'https://app.example.com/q/sarit-walkin')
  assert.equal((await t.call('POST', `/admin/quote/links/${campaign.link.id}/revoke`, SALES)).json().link.state, 'revoked')
  assert.equal((await t.pub('GET', '/quote/entry/sarit-walkin')).statusCode, 410)
  assert.equal((await t.pub('GET', '/quote/entry/nothing-here')).statusCode, 404)
  assert.equal((await t.pub('GET', '/quote/entry/a b')).statusCode, 400)
})

test('campaign link: QR code presets the town, codes are unique, and a campaign link never carries a name', async () => {
  const t = await setup()
  const res = await t.call('POST', '/admin/quote/links', ADMIN, { kind: 'campaign', code: 'Junction-Walkin', label: 'Junction poster', town: 'Ngong Road', industry: 'malls', source: 'qr' })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().link.code, 'junction-walkin')
  assert.deepEqual((await t.pub('GET', '/quote/entry/JUNCTION-WALKIN')).json(), { kind: 'campaign', prefill: { moduleKey: 'other', industryHint: 'malls', town: 'Ngong Road' } })
  assert.equal((await t.call('POST', '/admin/quote/links', ADMIN, { kind: 'campaign', code: 'junction-walkin', label: 'Again', source: 'qr' })).statusCode, 409)
  assert.equal((await t.call('POST', '/admin/quote/links', ADMIN, { kind: 'campaign', label: 'Bad', industry: 'spaceships', source: 'qr' })).statusCode, 400)
  // No personal data on a campaign link: a name is not accepted
  assert.equal((await t.call('POST', '/admin/quote/links', ADMIN, { kind: 'campaign', label: 'x', source: 'qr', firstName: 'Amina' })).statusCode, 201)
  assert.equal(t.store.dump().entryLinks.at(-1)!.prefill.firstName, undefined)
  // Uses count; the lead has no owner from a campaign link
  const { lead } = await t.visit({ code: 'junction-walkin' })
  assert.equal(lead.ownerStaffId, null)
  assert.equal(lead.source, 'qr')
  assert.equal(t.store.dump().entryLinks[0].uses, 1)
})

test('partners: ?p= credits the first partner only; commission is owed once fully paid and paid out once', async () => {
  const t = await setup()
  // Only admins set partner terms
  assert.equal((await t.call('POST', '/admin/quote/partners', SALES, { name: 'Kilimani Agents', code: 'kili', commissionType: 'percent', commissionValue: 1_000 })).statusCode, 403)
  assert.equal((await t.call('POST', '/admin/quote/partners', ADMIN, { name: 'Too much', code: 'BIG', commissionType: 'percent', commissionValue: 6_000 })).statusCode, 400)
  const kili = (await t.call('POST', '/admin/quote/partners', ADMIN, { name: 'Kilimani Agents', code: 'kili', commissionType: 'percent', commissionValue: 1_000 })).json().partner
  assert.equal(kili.code, 'KILI')
  await t.call('POST', '/admin/quote/partners', ADMIN, { name: 'Other Agent', code: 'OTHER', commissionType: 'fixed', commissionValue: 2_000 })
  assert.equal((await t.call('POST', '/admin/quote/partners', ADMIN, { name: 'Dup', code: 'KILI', commissionType: 'fixed', commissionValue: 1 })).statusCode, 409)

  const { lead } = await t.visit({ partnerCode: 'kili' })
  assert.equal(lead.partnerId, kili.id)
  // Same number comes back through another partner: the first keeps it
  await t.visit({ partnerCode: 'OTHER' })
  assert.equal(t.store.dump().leads[0].partnerId, kili.id)
  // A mistyped code is ignored, not an error
  assert.equal((await t.pub('POST', '/quote/requests', { moduleKey: 'homes', entry: { partnerCode: 'no such!' } })).statusCode, 201)
  // A code no partner has credits nobody
  const other = await t.visit({ partnerCode: 'ZZZ' }, '0712 345 671', 'Otieno')
  assert.equal(other.lead.partnerId, null)
  assert.equal((await t.call('GET', '/admin/quote/partners', SALES)).json().partners.find((p: any) => p.code === 'KILI').leads, 1)

  // A job for that lead: KES 25,000 before VAT, 29,000 with it
  const d = t.store.dump()
  d.quotes.push({ id: 'q1', options: [{ tier: 'standard', net: 25_000, total: 29_000 }] } as any)
  d.jobs.push({ id: '00000000-0000-4000-8000-0000000000a1', ref: 'VJ-0001', quoteId: 'q1', leadId: lead.id, optionTier: 'standard', status: 'delivered', currency: 'KES', depositStatus: 'paid', balanceStatus: 'pending', balancePaidAt: null } as any)
  const jobId = d.jobs[0].id

  assert.equal((await t.call('GET', '/admin/quote/commission', SALES)).statusCode, 403)
  let report = (await t.call('GET', '/admin/quote/commission')).json()
  assert.equal(report.rows[0].commissionStatus, 'waiting')
  assert.deepEqual(report.totals.KES, { owed: 0, paid: 0, waiting: 2_500 })
  assert.equal((await t.call('POST', '/admin/quote/commission/payouts', ADMIN, { jobIds: [jobId] })).statusCode, 409, 'not owed until the balance is paid')

  Object.assign(d.jobs[0], { balanceStatus: 'paid', balancePaidAt: '2026-11-10T09:00:00Z' })
  report = (await t.call('GET', '/admin/quote/commission')).json()
  assert.deepEqual([report.rows[0].commission, report.rows[0].commissionStatus], [2_500, 'owed'])
  const csv = await t.call('GET', '/admin/quote/commission.csv')
  assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8')
  assert.match(csv.body, /Kilimani Agents,KILI,VJ-0001,Wanjiku,KES,25000,10%,2500,owed/)

  assert.deepEqual((await t.call('POST', '/admin/quote/commission/payouts', ADMIN, { jobIds: [jobId], reference: 'QK7H2' })).json(), { recorded: 1 })
  assert.equal((await t.call('POST', '/admin/quote/commission/payouts', ADMIN, { jobIds: [jobId] })).statusCode, 409, 'never paid twice')
  // Changing the rate later does not change what was paid
  await t.call('PATCH', `/admin/quote/partners/${kili.id}`, ADMIN, { commissionValue: 500 })
  report = (await t.call('GET', '/admin/quote/commission')).json()
  assert.deepEqual([report.rows[0].commission, report.rows[0].commissionStatus, report.rows[0].payout.reference], [2_500, 'paid', 'QK7H2'])
  assert.ok(t.store.dump().audit.some(a => a.entityType === 'partner_payout' && a.actorId === ADMIN))
})
