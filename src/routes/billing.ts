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
    return reply.send(plans)
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
  fastify.post('/webhook/paystack', async (request, reply) => {
    const secret = process.env.PAYSTACK_SECRET_KEY
    if (!secret) return reply.code(500).send()

    // 1. Verify Signature
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(request.body))
      .digest('hex')

    if (hash !== request.headers['x-paystack-signature']) {
      fastify.log.warn('Invalid Paystack signature')
      return reply.code(400).send()
    }

    const event = request.body as any

    // Always return 200 to acknowledge receipt to Paystack
    reply.code(200).send()

    // 2. Process Event
    const eventType = event.event
    const { metadata, reference } = event.data
    const userId = metadata?.user_id
    const planId = metadata?.plan_id
    const billingCycle = metadata?.billing_cycle

    if (!userId && (eventType === 'charge.success' || eventType === 'subscription.create')) {
      fastify.log.error('Webhook missing metadata', event.data)
      return
    }

    if (eventType === 'charge.success' || eventType === 'subscription.create') {
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

      if (sub && sub.status === 'active') {
        await fastify.supabase
          .from('subscriptions')
          .update({ status: 'grace_period', updated_at: new Date().toISOString() })
          .eq('user_id', userId)
      }
    }
  })

  // GET SUBSCRIPTION STATUS
  fastify.get('/subscription-status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data: sub, error } = await fastify.supabase
      .from('subscriptions')
      .select('*, plans(*)')
      .eq('user_id', userId)
      .single()

    if (error || !sub) {
      // Return default free state
      const { data: freePlan } = await fastify.supabase
        .from('plans')
        .select('*')
        .eq('name', 'Free')
        .single()
      
      return reply.send({ subscription: null, plan: freePlan })
    }

    return reply.send({ subscription: sub, plan: sub.plans })
  })
}
