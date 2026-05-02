import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  fastify.get('/sync-limits', async (request, reply) => {
    // Key is passed in x-maintenance-key header (never in URL — would appear in server logs)
    const key = (request.headers['x-maintenance-key'] as string | undefined) ?? ''
    const expectedKey = process.env.MAINTENANCE_KEY
    if (!expectedKey || key !== expectedKey) {
      return reply.code(403).send({ error: 'Unauthorized' })
    }

    try {
      console.log('🔄 Maintenance: Updating plan upload limits...')
      const { data, error } = await fastify.supabase
        .from('plans')
        .update({ max_upload_bytes: 15728640 }) // 15MB
        .lt('max_upload_bytes', 15728640)

      if (error) {
        throw error
      }

      return reply.send({ success: true, message: 'Plan limits synchronized to 15MB' })
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}
