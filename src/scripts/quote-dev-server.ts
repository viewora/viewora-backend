// Local quote API for trying the form and the staff admin without Supabase:
// the real routes, validation and pricing engine over the in-memory store.
// Data is lost on restart. Run: npx tsx src/scripts/quote-dev-server.ts  (port 4010)
//
// Admin routes need `Authorization: Bearer <ADMIN_SECRET>` (default dev-secret)
// and X-Admin-Id: 00000000-0000-4000-8000-000000000001 (admin "Dev admin") or
// 00000000-0000-4000-8000-000000000002 (sales "Dev sales", 5% discount limit).
// Alerts and quote emails stay in sandbox: recorded on the lead, never sent.

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { CONSENT_EN } from '../quote/seed/consent.js'

process.env.ADMIN_SECRET ||= 'dev-secret'
const DEV_ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const DEV_SALES_ID = '00000000-0000-4000-8000-000000000002'
const port = Number(process.env.PORT ?? 4010)

// Same wording as migrations 003 and 004 seed into qe_message_templates
const store = memoryStore({
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
  },
  recipients: ['staff@localhost'],
  staff: [
    { userId: DEV_ADMIN_ID, displayName: 'Dev admin', role: 'admin', discountLimitBp: 10_000, email: 'admin@localhost', active: true },
    { userId: DEV_SALES_ID, displayName: 'Dev sales', role: 'sales', discountLimitBp: 500, email: 'sales@localhost', active: true },
  ],
})
function devClock(): (() => Date) | null {
  const m = /^(\d{2}):(\d{2})$/.exec(process.env.QUOTE_DEV_CLOCK ?? '')
  if (!m) return null
  return () => {
    const d = new Date()
    d.setUTCHours((Number(m[1]) + 21) % 24, Number(m[2]))   // Nairobi is UTC+3
    return d
  }
}
const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
const desk = memoryDeskStore(() => store.dump())
await app.register(quoteRoutes, {
  prefix: '/quote',
  store,
  desk,
  alerts: { liveSend: false, extraRecipients: [], adminUrl: 'http://localhost:3002', send: async () => {} },
})
await app.register(quoteAdminRoutes, {
  prefix: '/admin/quote', store, desk, adminStore: memoryAdminStore(() => store.dump()),
  messagesLive: false, publicUrl: process.env.QUOTE_PUBLIC_URL ?? 'http://localhost:3001',
  // QUOTE_DEV_CLOCK=12:00 pretends it is that Nairobi time today, to try
  // WhatsApp and email sends at night (quiet hours are 21:00-07:00)
  ...(devClock() ? { now: devClock()! } : {}),
})
// Peek at what the form saved: http://localhost:4010/dev/dump
app.get('/dev/dump', async () => store.dump())

await app.listen({ port, host: '127.0.0.1' })
console.log(`quote dev API on http://127.0.0.1:${port}`)
