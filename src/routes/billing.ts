import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import axios from 'axios'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const initializeBillingBodySchema = z.object({
  planId: z.string().uuid(),
  billingCycle: z.enum(['monthly', 'yearly']),
})

const PLANS_REDIS_KEY = 'plans:all'
const PLANS_TTL_SECS = 300 // 5 minutes

export default async function (fastify: FastifyInstance) {

  // GET ALL PLANS
  fastify.get('/plans', async (request, reply) => {
    // Use Redis so all API instances share the same cache — avoids stale/divergent
    // plan data when multiple Railway replicas are running
    if (fastify.redis) {
      const cached = await fastify.redis.get(PLANS_REDIS_KEY).catch(() => null)
      if (cached) {
        reply.header('Cache-Control', 'public, max-age=300')
        return reply.send(JSON.parse(cached))
      }
    }

    const { data: plans, error } = await fastify.supabase
      .from('plans')
      .select('*')
      .order('price_monthly_kes', { ascending: true })

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch plans' })

    const mappedPlans = (plans || []).map(p => ({
      ...p,
      max_active_spaces: p.max_active_properties,
      max_active_properties: undefined
    }))

    if (fastify.redis) {
      void fastify.redis.setEx(PLANS_REDIS_KEY, PLANS_TTL_SECS, JSON.stringify(mappedPlans)).catch(() => {})
    }

    reply.header('Cache-Control', 'public, max-age=300')
    return reply.send(mappedPlans)
  })

  // INITIALIZE PAYSTACK TRANSACTION
  fastify.post('/initialize-paystack', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = parseWithSchema(reply, initializeBillingBodySchema, request.body)
    if (!body) return
    const { planId, billingCycle } = body

    // 1. Get Plan details
    const { data: plan, error: planErr } = await fastify.supabase
      .from('plans')
      .select('*')
      .eq('id', planId)
      .single()

    if (planErr || !plan) {
      return reply.code(400).send({ statusMessage: 'Invalid plan' })
    }

    const amountKES = billingCycle === 'yearly' ? plan.price_yearly_kes : plan.price_monthly_kes
    if (amountKES === 0) {
      return reply.code(400).send({ statusMessage: 'Cannot initialize payment for free plan' })
    }

    // 2. Get User Email — use JWT claim (always fresh, no extra DB round-trip)
    const email = (request.user as any)?.email as string | undefined

    if (!email) {
      return reply.code(400).send({ statusMessage: 'User email not found' })
    }

    // 3. Call Paystack API
    const paystackSecret = process.env.PAYSTACK_SECRET_KEY
    if (!paystackSecret) {
      fastify.log.error('PAYSTACK_SECRET_KEY missing')
      return reply.code(500).send({ statusMessage: 'Billing configuration error' })
    }

    request.log.info({ userId, planId, billingCycle }, 'Initializing new Paystack subscription transaction')

    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email,
          amount: amountKES * 100, // Paystack expects amount in smallest currency unit (cents/kobo)
          currency: 'KES',
          callback_url: `${process.env.APP_URL || 'https://app.viewora.software'}/app/billing`,
          metadata: {
            user_id: userId,
            plan_id: planId,
            billing_cycle: billingCycle
          }
        },
        {
          headers: {
            Authorization: `Bearer ${paystackSecret}`,
            'Content-Type': 'application/json'
          },
          timeout: 10_000,
        }
      )

      const paystackData = (response.data as any)
      if (!paystackData?.status) {
        fastify.log.error({ paystackData }, 'Paystack returned status: false')
        return reply.code(502).send({ statusMessage: 'Payment provider returned an error' })
      }
      return reply.send(paystackData.data)
    } catch (err: any) {
      fastify.log.error(err.response?.data || err.message)
      return reply.code(500).send({ statusMessage: 'Failed to initialize payment' })
    }
  })

  // WEBHOOK: VERIFY AND UPDATE SUBSCRIPTION
  // This route must NOT use the authenticate hook
  fastify.post('/webhook/paystack', { config: { rawBody: true } }, async (request, reply) => {
    const secret = process.env.PAYSTACK_SECRET_KEY
    if (!secret) return reply.code(500).send()

    // 1. Verify Signature
    if (!request.rawBody) {
      fastify.log.error('Missing raw body in webhook request')
      return reply.code(400).send()
    }

    const hash = crypto
      .createHmac('sha512', secret)
      .update(request.rawBody)
      .digest('hex')

    const incomingSignatureRaw = request.headers['x-paystack-signature']
    const incomingSignature = Array.isArray(incomingSignatureRaw) ? incomingSignatureRaw[0] : incomingSignatureRaw

    if (!incomingSignature || incomingSignature.length !== hash.length) {
      fastify.log.warn({ ip: request.ip }, 'CRITICAL: Missing or malformed Paystack webhook signature')
      return reply.code(400).send()
    }

    let isValidSignature = false
    try {
      isValidSignature = crypto.timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(incomingSignature, 'hex')
      )
    } catch {
      // timingSafeEqual throws if buffers differ in length (non-hex chars in signature)
    }

    if (!isValidSignature) {
      fastify.log.warn({ ip: request.ip }, 'CRITICAL: Blocked invalid Paystack webhook signature')
      return reply.code(400).send()
    }

    const body = request.body as any
    fastify.log.info({ event: body.event }, 'Verified secure Paystack webhook')

    // Always return 200 immediately to acknowledge receipt to Paystack
    reply.code(200).send()

    // 2. Process Event asynchronously after ack
    const eventType = body.event
    const { metadata, data } = body ?? {}
    const eventMetadata = data?.metadata || metadata || {}
    const { reference } = data ?? {}

    // Validate that metadata fields are proper UUIDs before touching the DB.
    // The webhook body is Paystack-signed but the metadata was set by our own code;
    // a UUID check guards against any future metadata tampering or Paystack bugs.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const userId: string | undefined = typeof eventMetadata?.user_id === 'string' && UUID_RE.test(eventMetadata.user_id)
      ? eventMetadata.user_id
      : undefined
    const planId: string | undefined = typeof eventMetadata?.plan_id === 'string' && UUID_RE.test(eventMetadata.plan_id)
      ? eventMetadata.plan_id
      : undefined
    const billingCycle: string | undefined = eventMetadata?.billing_cycle

    if (eventType === 'charge.success' || eventType === 'subscription.create') {
      if (!userId || !planId || !billingCycle) {
        fastify.log.error({ data }, 'Webhook missing or invalid required metadata')
        return
      }

      // Idempotency: Redis-first dedup with 3-day TTL covers the full Paystack replay window.
      // DB fallback handles cold-start (Redis empty after restart) and cases where a user
      // renews and overwrites provider_reference — the old reference would then escape the
      // DB check but is still blocked by the Redis key until it expires.
      if (reference) {
        const redisKey = `webhook:ref:${reference}`
        if (fastify.redis) {
          const seen = await fastify.redis.get(redisKey).catch(() => null)
          if (seen) {
            fastify.log.info({ reference }, 'Webhook skipped — reference in Redis replay cache')
            return
          }
          // Write first so a concurrent replay is also blocked
          await fastify.redis.set(redisKey, '1', { EX: 259200 }).catch(() => {}) // 3 days
        }

        // DB fallback: catches replays that arrive before Redis is populated (e.g. first boot)
        const { data: existing } = await fastify.supabase
          .from('subscriptions')
          .select('id')
          .eq('user_id', userId)
          .eq('provider_reference', reference)
          .maybeSingle()
        if (existing) {
          fastify.log.info({ reference }, 'Webhook skipped — reference already in subscriptions table')
          return
        }
      }

      // Upsert Subscription
      const currentPeriodStart = new Date()
      const currentPeriodEnd = new Date()
      if (billingCycle === 'yearly') {
        currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1)
      } else {
        currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1)
      }

      // 7 day grace period
      const gracePeriodEndsAt = new Date(currentPeriodEnd)
      gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + 7)

      await fastify.supabase
        .from('subscriptions')
        .upsert(
          {
            user_id: userId,
            plan_id: planId,
            provider: 'paystack',
            provider_reference: reference,
            status: 'active',
            billing_cycle: billingCycle,
            current_period_start: currentPeriodStart.toISOString(),
            current_period_end: currentPeriodEnd.toISOString(),
            grace_period_ends_at: gracePeriodEndsAt.toISOString(),
            updated_at: new Date().toISOString()
          },
          { onConflict: 'user_id' }
        )
    } else if (eventType === 'subscription.disable' || eventType === 'invoice.payment_failed') {
      if (!userId) { fastify.log.error({ event: eventType }, 'Webhook missing user_id for disable event'); return }
      const { data: sub } = await fastify.supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
        await fastify.supabase
          .from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('user_id', userId)

        // Invalidate billing cache so the next request reflects the new status immediately
        if (fastify.redis) {
          await fastify.redis.del(`billing:status:${userId}`).catch(() => {})
        }
      }
    }
  })

  // GET SUBSCRIPTION STATUS (RENAMED to /status for frontend consistency)
  fastify.get('/status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Serve from Redis cache for 5 minutes — this is polled on every editor load
    const cacheKey = `billing:status:${userId}`
    if (fastify.redis) {
      const cached = await fastify.redis.get(cacheKey).catch(() => null)
      if (cached) {
        reply.header('Cache-Control', 'private, max-age=300')
        return reply.send(JSON.parse(cached))
      }
    }

    // Run subscription + usage queries in parallel
    const [{ data: sub }, { data: usage }] = await Promise.all([
      fastify.supabase.from('subscriptions').select('*, plans(*)').eq('user_id', userId).single(),
      fastify.supabase.from('usage_counters').select('active_properties_count, storage_used_bytes').eq('user_id', userId).single(),
    ])

    let responsePlan: any = sub?.plans || null
    if (!responsePlan) {
      const { data: freePlan } = await fastify.supabase.from('plans').select('*').eq('name', 'Free').single()
      responsePlan = freePlan
    }

    const mappedPlan = responsePlan ? {
      ...responsePlan,
      max_active_spaces: responsePlan.max_active_properties,
      max_active_properties: undefined,
    } : null

    const result = {
      subscription: sub || null,
      plan: mappedPlan,
      usage: {
        active_spaces_count: usage?.active_properties_count || 0,
        storage_used_bytes: usage?.storage_used_bytes || 0,
      },
    }

    if (fastify.redis) {
      void fastify.redis.setEx(cacheKey, 300, JSON.stringify(result)).catch(() => {})
    }

    reply.header('Cache-Control', 'private, max-age=300')
    return reply.send(result)
  })
}
