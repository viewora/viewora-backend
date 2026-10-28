// Local quote API for trying the form and the staff admin without Supabase:
// the real routes, validation and pricing engine over the in-memory store.
// Data is lost on restart. Run: npx tsx src/scripts/quote-dev-server.ts  (port 4010)
//
// Admin routes need `Authorization: Bearer <ADMIN_SECRET>` (default dev-secret)
// and X-Admin-Id: 00000000-0000-4000-8000-000000000001 (admin "Dev admin") or
// 00000000-0000-4000-8000-000000000002 (sales "Dev sales", 5% discount limit).
// Alerts and quote emails stay in sandbox: recorded on the lead, never sent.
// Payments use a fake Paystack: "Pay deposit" opens a local checkout page
// (/dev/paystack/checkout) where you choose paid or failed.

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { fakePaystack } from '../quote/paystack.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { CONSENT_EN } from '../quote/seed/consent.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { messagingDeps, runFollowups } from '../quote/messaging.js'
import fs from 'node:fs'

process.env.ADMIN_SECRET ||= 'dev-secret'
const DEV_ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const DEV_SALES_ID = '00000000-0000-4000-8000-000000000002'
const port = Number(process.env.PORT ?? 4010)

// The follow-up wording, read from migration 006 so the two never drift
function migrationTemplates(file: string) {
  const sql = fs.readFileSync(new URL(`../utils/${file}`, import.meta.url), 'utf8')
  const out: Record<string, { version: number; subject: string | null; body: string }> = {}
  const unquote = (s: string) => s.replace(/''/g, "'").replace(/\\n/g, '\n')
  for (const m of sql.matchAll(/\('(\w+)', '(whatsapp|email)', 'en', 1, (NULL|'(?:[^']|'')*'),\s*E'((?:[^']|'')*)'\)/g)) {
    out[`${m[1]}:${m[2]}`] = { version: 1, subject: m[3] === 'NULL' ? null : unquote(m[3].slice(1, -1)), body: unquote(m[4]) }
  }
  return out
}

// A clock you can move forward to try the reminders: POST /dev/clock {"minutes": 16}.
// QUOTE_DEV_CLOCK=12:00 starts it at that Nairobi time today, so messages
// can be tried at night (quiet hours are 21:00-07:00).
let offsetMs = 0
{
  const m = /^(\d{2}):(\d{2})$/.exec(process.env.QUOTE_DEV_CLOCK ?? '')
  if (m) {
    const target = new Date()
    target.setUTCHours((Number(m[1]) + 21) % 24, Number(m[2]), 0, 0)   // Nairobi is UTC+3
    offsetMs = target.getTime() - Date.now()
  }
}
const clock = () => new Date(Date.now() + offsetMs)

// Same wording as migrations 003 and 004 seed into qe_message_templates
const store = memoryStore({
  clock,
  rateTable: rateTableV1,
  consent: { id: 'local-consent-en', body: CONSENT_EN },
  templates: {
    'staff_new_lead:email': {
      version: 1,
      subject: 'New quote lead: {{name}}, {{industry}}',
      body: 'A new lead just came in from the quote form.\n\nName: {{name}}\nIndustry: {{industry}}\nWho they are: {{client_type}}\nSource: {{source}}\n\nOpen the lead: {{admin_link}}',
    },
    'quote_link:whatsapp': {
      version: 1,
      subject: null,
      body: 'Hi {{name}}, here is your Viewora quote for {{industry}}: {{quote_link}}\n\n{{amount}}, valid until {{valid_until}}. Reply here if you have any questions.\n\n{{staff_name}}, Viewora',
    },
    'quote_link:email': {
      version: 1,
      subject: 'Your Viewora quote: {{amount}}',
      body: 'Hi {{name}},\n\nThank you for asking about a Viewora tour for {{industry}}. Your quote is attached as a PDF, and you can also open it here:\n{{quote_link}}\n\n{{amount}}, valid until {{valid_until}}.\n\nReply to this email or WhatsApp us if you would like anything changed.\n\n{{staff_name}}, Viewora',
    },
    // Same wording as migration 005
    'deposit_paid:email': {
      version: 1,
      subject: 'Deposit received: {{amount}} for your Viewora tour',
      body: 'Hi {{name}},\n\nThank you. We received your deposit of {{amount}} for the {{option}} option (quote {{quote_ref}}).\n\nIf you have not picked a shoot day yet, open your quote link again and choose one there. We will confirm the day on WhatsApp.\n\nBefore the shoot:\n- Tidy each room and open the curtains.\n- Switch on every light.\n- Move cars, bins and personal items out of view.\n\nThe balance of {{balance}} is due when we deliver your tour.\n\nThe Viewora team',
    },
    'balance_request:whatsapp': {
      version: 1,
      subject: null,
      body: 'Hi {{name}}, your Viewora tour is ready. The balance is {{amount}}. You can pay by M-Pesa or card here: {{pay_link}}\n\nThank you!',
    },
    'staff_deposit_paid:email': {
      version: 1,
      subject: 'Deposit paid: {{name}}, {{amount}}',
      body: '{{name}} paid a {{amount}} deposit for {{industry}} ({{option}}, quote {{quote_ref}}).\n\nThey will pick a shoot day on the quote page. Open the job: {{admin_link}}',
    },
  },
  recipients: ['staff@localhost'],
  staff: [
    { userId: DEV_ADMIN_ID, displayName: 'Dev admin', role: 'admin', discountLimitBp: 10_000, email: 'admin@localhost', active: true },
    { userId: DEV_SALES_ID, displayName: 'Dev sales', role: 'sales', discountLimitBp: 500, email: 'sales@localhost', active: true },
  ],
})
const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
const desk = memoryDeskStore(() => store.dump())
const jobs = memoryJobStore(() => store.dump())
const paystack = fakePaystack(`http://localhost:${port}/dev/paystack/checkout`)
const publicUrl = process.env.QUOTE_PUBLIC_URL ?? 'http://localhost:3001'
const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'http://localhost:3002', send: async () => {} }
const payments = { paystack, publicUrl, messagesLive: false, alerts, track: () => {}, now: clock }
const followups = memoryFollowupStore(() => store.dump())
const messaging = { now: clock, publicUrl, messagesLive: false, optOutSecret: 'dev-optout' }
await app.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, payments, followups, messaging, webhookSecret: 'sk_test_dev' })
await app.register(quoteAdminRoutes, {
  prefix: '/admin/quote', store, desk, jobs, payments, followups, adminStore: memoryAdminStore(() => store.dump()),
  messagesLive: false, publicUrl, now: clock,
})
// Peek at what the form saved: http://localhost:4010/dev/dump
app.get('/dev/dump', async () => store.dump())

// Follow-ups: the scheduler's job, every 20 seconds here (5 minutes in production).
// Move the clock to see reminders: POST /dev/clock {"minutes": 16}
const followupDeps = messagingDeps({ store, desk, jobs, followups, alerts, log: app.log }, messaging)
const runNow = () => runFollowups(followupDeps).catch(err => { app.log.error(err, 'dev follow-ups failed'); return null })
setInterval(runNow, 20_000).unref()
app.post('/dev/clock', async request => {
  const minutes = Number((request.body as any)?.minutes ?? 0)
  if (Number.isFinite(minutes) && minutes > 0) offsetMs += minutes * 60_000
  return { now: clock().toISOString(), ran: await runNow() }
})
// Pretend the lead wrote to us on WhatsApp: POST /dev/whatsapp-reply {"e164": "+2547..."}
app.post('/dev/whatsapp-reply', async request => ({ leadId: await followups.replied(String((request.body as any)?.e164 ?? '')) }))

// Fake Paystack checkout. A real one shows card and M-Pesa; this one lets
// you pick the outcome, then returns to the quote page like Paystack does.
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
app.get('/dev/paystack/checkout', async (request, reply) => {
  const ref = String((request.query as any).reference ?? '')
  const t = paystack.transactions.get(ref)
  if (!t) return reply.code(404).type('text/html').send('<p>No such test checkout.</p>')
  const amount = `${t.currency} ${(t.amount / 100).toLocaleString('en-KE')}`
  const button = (outcome: string, label: string) =>
    `<form method="post" action="/dev/paystack/complete"><input type="hidden" name="reference" value="${esc(ref)}"><input type="hidden" name="outcome" value="${outcome}"><button>${label}</button></form>`
  return reply.type('text/html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
<style>body{font:16px system-ui;margin:0;padding:24px 16px;max-width:420px}button{width:100%;min-height:48px;margin:6px 0;font:inherit;border:1px solid #888;border-radius:6px;background:#fff}p{color:#555}</style>
<h1>Test checkout</h1><p>Local fake of Paystack. No money moves.</p><p><strong>${esc(amount)}</strong> · ${esc(t.email)}</p>
${button('mobile_money', 'Pay with M-Pesa (test)')}${button('card', 'Pay with card (test)')}${button('failed', 'Payment fails')}
<p><a href="${esc(t.callbackUrl)}">Close without paying</a></p>`)
})
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))))
app.post('/dev/paystack/complete', async (request, reply) => {
  const { reference, outcome } = request.body as Record<string, string>
  const t = paystack.transactions.get(reference)
  if (!t) return reply.code(404).send('No such test checkout.')
  paystack.complete(reference, outcome === 'failed' ? { status: 'failed' } : { channel: outcome })
  const back = new URL(t.callbackUrl)
  back.searchParams.set('trxref', reference)
  back.searchParams.set('reference', reference)
  return reply.redirect(back.toString())
})

await app.listen({ port, host: '127.0.0.1' })
console.log(`quote dev API on http://127.0.0.1:${port}`)
