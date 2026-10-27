// Local quote API for trying the form and the staff admin without Supabase:
// the real routes, validation and pricing engine over the in-memory store.
// Data is lost on restart. Run: npx tsx src/scripts/quote-dev-server.ts  (port 4010)
//
// Admin routes need `Authorization: Bearer <ADMIN_SECRET>` (default dev-secret)
// and `X-Admin-Id: 00000000-0000-4000-8000-000000000001` (an admin here).
// New-lead alerts stay in sandbox: they are recorded on the lead, never sent.

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { CONSENT_EN } from '../quote/seed/consent.js'

process.env.ADMIN_SECRET ||= 'dev-secret'
const DEV_ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const port = Number(process.env.PORT ?? 4010)

// Same wording as migration 003 seeds into qe_message_templates
const store = memoryStore({
  rateTable: rateTableV1,
  consent: { id: 'local-consent-en', body: CONSENT_EN },
  templates: {
    'staff_new_lead:email': {
      version: 1,
      subject: 'New quote lead: {{name}}, {{industry}}',
      body: 'A new lead just came in from the quote form.\n\nName: {{name}}\nIndustry: {{industry}}\nWho they are: {{client_type}}\nSource: {{source}}\n\nOpen the lead: {{admin_link}}',
    },
  },
  recipients: ['staff@localhost'],
})
const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
await app.register(quoteRoutes, {
  prefix: '/quote',
  store,
  alerts: { liveSend: false, extraRecipients: [], adminUrl: 'http://localhost:3002', send: async () => {} },
})
await app.register(quoteAdminRoutes, { prefix: '/admin/quote', store, adminStore: memoryAdminStore(() => store.dump(), { [DEV_ADMIN_ID]: 'admin' }) })
// Peek at what the form saved: http://localhost:4010/dev/dump
app.get('/dev/dump', async () => store.dump())

await app.listen({ port, host: '127.0.0.1' })
console.log(`quote dev API on http://127.0.0.1:${port}`)
