import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

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
