import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { normalizeWhatsAppWebhook, type WhatsAppWebhookBody } from '../adapters/whatsapp/normalizer.js'
import { sendMessage, fetchMedia } from '../adapters/whatsapp/client.js'
import { handleIncomingMessage } from '../conversation/orchestrator.js'

export default async function whatsappRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_req, reply) => reply.code(200).send({ status: 'ok' }))

  // Meta calls this once, synchronously, when you save the webhook URL in
  // the App Dashboard (WhatsApp > Configuration > Webhook > Edit) to prove
  // you control this endpoint — must echo hub.challenge back verbatim if
  // the verify token matches what you configured there. This route must
  // already be live at the target URL before you click "Verify and Save".
  fastify.get('/webhook', async (request, reply) => {
    const query = request.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(200).send(challenge)
    }
    fastify.log.warn({ mode }, 'WhatsApp webhook verification failed — check WHATSAPP_VERIFY_TOKEN matches the App Dashboard')
    return reply.code(403).send('Verification failed')
  })

  // Production path. Meta expects a fast ack — respond immediately, then
  // process, same pattern as routes/telegram.ts. config:{rawBody:true}
  // (fastify-raw-body, registered globally in index.ts) exposes
  // request.rawBody for the signature check below — the same mechanism
  // routes/billing.ts's Paystack webhook already uses.
  fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const appSecret = process.env.WHATSAPP_APP_SECRET
    if (appSecret) {
      const signatureHeader = request.headers['x-hub-signature-256']
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(request.rawBody || '').digest('hex')
      const valid = !!signature
        && signature.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      if (!valid) {
        fastify.log.warn({ ip: request.ip }, 'CRITICAL: Blocked invalid WhatsApp webhook signature')
        return reply.code(403).send()
      }
    } else {
      fastify.log.warn('WHATSAPP_APP_SECRET not set — webhook signature is NOT being verified')
    }

    reply.code(200).send({ received: true })

    const body = request.body as WhatsAppWebhookBody
    const message = normalizeWhatsAppWebhook(body)
    if (!message) return

    // Quote engine (read-only tap): a message from a quote lead's number
    // stops their follow-ups. It never changes what the bot does.
    if (process.env.QUOTE_ENGINE_ENABLED === '1' && /^\d{8,15}$/.test(message.sender.id)) {
      import('../quote/followupStore.js')
        .then(({ supabaseFollowupStore }) => supabaseFollowupStore(fastify.supabase).replied(`+${message.sender.id}`))
        .then(leadId => { if (leadId) fastify.log.info({ leadId }, 'quote: lead replied on WhatsApp; follow-ups stopped') })
        .catch(err => fastify.log.error({ err: err?.message }, 'quote: reply hook failed'))
    }

    handleIncomingMessage(fastify, 'whatsapp', message, {
      sendReply: (to, text) => sendMessage(to, text),
      fetchMedia,
    }).catch((err) => {
      // Inlined into the log string (not just a structured field) because
      // some log viewers (Railway's included) collapse structured fields in
      // their default view, hiding exactly the detail needed to debug a
      // production failure — same reasoning as routes/telegram.ts.
      fastify.log.error(`WhatsApp webhook processing failed: ${err?.stack || err?.message || err}`)
      sendMessage(message.replyTo, 'Something went wrong on my end — try again in a moment.').catch(() => {})
    })
  })
}
