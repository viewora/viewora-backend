// The client's quote link (under /quote): GET /view/:token shows the quote,
// POST /view/:token/seen counts a view (the page calls it after it renders,
// so WhatsApp's link preview does not mark a quote as viewed), and
// GET /view/:token/pdf downloads it. Only the token's hash is stored; links
// expire, and all three routes are rate-limited per IP.

import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import type { DeskStore, LinkHit } from '../quote/deskStore.js'
import type { JobStore } from '../quote/jobStore.js'
import { publicQuote } from '../quote/publicQuote.js'
import { renderQuotePdf } from '../quote/pdf.js'
import { payBlocker } from '../quote/jobs.js'
import { publicJob } from '../quote/payments.js'

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
export const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } })

// The quote behind a link token, or a 404 already sent
export async function findHit(desk: DeskStore, reply: FastifyReply, params: unknown): Promise<{ hit: LinkHit; token: string } | null> {
  const p = parseWithSchema(reply, tokenParams, params)
  if (!p) return null
  const hit = await desk.findLink(hashToken(p.token))
  if (!hit) {
    reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'This quote link is not valid. Check you copied all of it, or ask us for a new one.' })
    return null
  }
  return { hit, token: p.token }
}

export default async function quotePublicRoutes(fastify: FastifyInstance, opts: {
  desk: DeskStore
  jobs?: JobStore                 // with it, the page shows the deposit button and the booking
  paymentsOn?: boolean
  now?: () => Date
  whatsappNumber?: string
  onViewed?: (quoteId: string, firstView: boolean) => void   // analytics hook (no personal data)
}) {
  const now = opts.now ?? (() => new Date())
  const whatsappNumber = opts.whatsappNumber ?? process.env.QUOTE_WHATSAPP ?? '254117537025'

  const find = async (reply: FastifyReply, params: unknown) => (await findHit(opts.desk, reply, params))?.hit ?? null

  fastify.get('/view/:token', { config: limit(60) }, async (request, reply) => {
    const hit = await find(reply, request.params)
    if (!hit) return
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex')
    const quote = publicQuote(hit, now())
    if (!opts.jobs || quote.state === 'gone' || quote.state === 'replaced' || quote.state === 'closed') return { quote, whatsapp: whatsappNumber }
    const job = await opts.jobs.jobForRequest(hit.quote.requestId)
    const blocker = payBlocker(hit.quote, quote.state, { hasJob: !!job, paymentsOn: !!opts.paymentsOn })
    return {
      quote, whatsapp: whatsappNumber,
      // A job only shows on the quote it was paid from
      job: job && job.quoteId === hit.quote.id ? publicJob(job) : null,
      pay: { blocker, needsEmail: !hit.lead?.email },
    }
  })

  fastify.post('/view/:token/seen', { config: limit(30) }, async (request, reply) => {
    const hit = await find(reply, request.params)
    if (!hit) return
    const view = publicQuote(hit, now())
    if (view.state === 'gone') return reply.code(204).send()
    const { firstView } = await opts.desk.linkSeen(hit.linkId)
    opts.onViewed?.(hit.quote.id!, firstView)
    return reply.code(204).send()
  })

  fastify.get('/view/:token/pdf', { config: limit(20) }, async (request, reply) => {
    const hit = await find(reply, request.params)
    if (!hit) return
    const view = publicQuote(hit, now())
    if (!view.options) {
      return reply.code(410).send({ code: view.state.toUpperCase(), statusMessage: 'This quote is no longer available as a PDF. Ask us for a new one.' })
    }
    const pdf = await renderQuotePdf(view, { whatsapp: whatsappNumber })
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="Viewora-quote-${view.ref}.pdf"`)
    return reply.send(pdf)
  })
}
