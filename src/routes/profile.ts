import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sendWelcomeEmail, isEmailEnabled } from '../email/index.js'

const UpdateProfileBodySchema = z.object({
  full_name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
})

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data, error } = await fastify.supabase
      .from('profiles')
      .select('id, full_name, avatar_url, phone, created_at, updated_at')
      .eq('id', userId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.code(404).send({ statusMessage: 'Profile not found' })
      }
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch profile' })
    }

    return reply.send(data)
  })

  fastify.post('/welcome', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    fastify.log.info({ userId }, 'welcome: endpoint hit')

    // Idempotency: only send once per user, even if called multiple times.
    // Skip the key if email is not configured — allows a retry once RESEND_API_KEY is set.
    const redisKey = `welcome_sent:${userId}`
    if (fastify.redis && isEmailEnabled()) {
      const already = await fastify.redis.get(redisKey).catch(() => null)
      if (already) {
        fastify.log.info({ userId }, 'welcome: already sent, skipping')
        return reply.code(200).send({ sent: false })
      }
      await fastify.redis.set(redisKey, '1', { EX: 60 * 60 * 24 * 365 }).catch(() => {})
    } else if (!isEmailEnabled()) {
      fastify.log.warn({ userId }, 'welcome: RESEND_API_KEY not set, skipping idempotency key')
    } else {
      fastify.log.warn({ userId }, 'welcome: redis unavailable, idempotency skipped')
    }

    const email = (request.user as any)?.email as string | undefined
    const name = (request.user as any)?.user_metadata?.full_name
      || (request.user as any)?.user_metadata?.name
      || null

    if (!email) {
      fastify.log.warn({ userId }, 'welcome: no email on user token')
      return reply.code(400).send({ statusMessage: 'Email not found' })
    }

    fastify.log.info({ userId, email }, 'welcome: sending email')
    void sendWelcomeEmail({ ownerEmail: email, name }).catch((err) => {
      fastify.log.error(err, 'welcome: failed to send email')
    })

    return reply.code(200).send({ sent: true })
  })

  fastify.patch('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const body = parseWithSchema(reply, UpdateProfileBodySchema, request.body)
    if (!body) return

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.full_name !== undefined) updates.full_name = body.full_name.trim() || null
    if (body.phone !== undefined) updates.phone = body.phone.trim() || null

    const { data, error } = await fastify.supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('id, full_name, avatar_url, phone, created_at, updated_at')
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update profile' })
    }
    return reply.send(data)
  })
}
