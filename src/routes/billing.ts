import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import axios from 'axios'

export default async function (fastify: FastifyInstance) {
  
  // GET ALL PLANS
  fastify.get('/plans', async (request, reply) => {
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

    return reply.send(mappedPlans)
  })

  // INITIALIZE PAYSTACK TRANSACTION
  fastify.post('/initialize-paystack', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = request.body as any
    const { planId, billingCycle } = body

    if (!planId || !billingCycle) {
      return reply.code(400).send({ statusMessage: 'planId and billingCycle are required' })
    }

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

    // 2. Get User Email
    const { data: profile } = await fastify.supabase
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single()

    const email = profile?.email

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
          callback_url: `${process.env.FRONTEND_URL || 'https://app.viewora.software'}/billing/callback`,
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
          }
        }
      )

      return reply.send((response.data as any).data)
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

    if (hash !== request.headers['x-paystack-signature']) {
      fastify.log.warn({ ip: request.ip }, 'CRITICAL: Blocked invalid Paystack webhook signature')
      return reply.code(400).send()
    }

    fastify.log.info({ event: request.body.event }, 'Verified secure Paystack webhook')
    const event = request.body as any

    // Always return 200 immediately to acknowledge receipt to Paystack
    reply.code(200).send()

    // 2. Process Event asynchronously after ack
    const eventType = event.event
    const { metadata, reference } = event.data ?? {}
    const userId: string | undefined = metadata?.user_id
    const planId: string | undefined = metadata?.plan_id
    const billingCycle: string | undefined = metadata?.billing_cycle

    if (eventType === 'charge.success' || eventType === 'subscription.create') {
      if (!userId || !planId || !billingCycle) {
        fastify.log.error('Webhook missing required metadata', event.data)
        return
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
      // Move to past_due or grace_period
      // For simplicity in MVP, we move to grace_period if they had an active sub
      const { data: sub } = await fastify.supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
        if (!userId) { fastify.log.error('Webhook missing user_id for disable event'); return }
        await fastify.supabase
          .from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('user_id', userId)
      }
    }
  })

  // GET SUBSCRIPTION STATUS (RENAMED to /status for frontend consistency)
  fastify.get('/status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // 1. Get Subscription + Plan
    const { data: sub } = await fastify.supabase
      .from('subscriptions')
      .select('*, plans(*)')
      .eq('user_id', userId)
      .single()

    // 2. Get Usage
    const { data: usage } = await fastify.supabase
      .from('usage_counters')
      .select('active_properties_count, storage_used_bytes')
      .eq('user_id', userId)
      .single()

    const finalPlan = sub?.plans || null
    let responsePlan: any = null

    if (!finalPlan) {
      // Return default free state
      const { data: freePlan } = await fastify.supabase
        .from('plans')
        .select('*')
        .eq('name', 'Free')
        .single()
      responsePlan = freePlan
    } else {
      responsePlan = finalPlan
    }

    const mappedPlan = responsePlan ? {
      ...responsePlan,
      max_active_spaces: responsePlan.max_active_properties,
      max_active_properties: undefined
    } : null

    const mappedUsage = {
      active_spaces_count: usage?.active_properties_count || 0,
      storage_used_bytes: usage?.storage_used_bytes || 0
    }

    return reply.send({ 
      subscription: sub || null, 
      plan: mappedPlan,
      usage: mappedUsage
    })
  })
}
