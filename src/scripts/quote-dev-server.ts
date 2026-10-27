// Local quote API for trying the form without Supabase: the real routes,
// validation and pricing engine over the in-memory store. Data is lost on
// restart. Run: npx tsx src/scripts/quote-dev-server.ts  (port 4010)

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import quoteRoutes from '../routes/quote.js'
import { memoryStore } from '../quote/store.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { CONSENT_EN } from '../quote/seed/consent.js'

const port = Number(process.env.PORT ?? 4010)
const store = memoryStore({ rateTable: rateTableV1, consent: { id: 'local-consent-en', body: CONSENT_EN } })
const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
await app.register(quoteRoutes, { prefix: '/quote', store })
// Peek at what the form saved: http://localhost:4010/dev/dump
app.get('/dev/dump', async () => store.dump())

await app.listen({ port, host: '127.0.0.1' })
console.log(`quote dev API on http://127.0.0.1:${port}`)
