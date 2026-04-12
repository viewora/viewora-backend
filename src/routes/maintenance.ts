import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const maintenanceQuerySchema = z.object({
  key: z.string().min(1),
})

export default async function (fastify: FastifyInstance) {
  fastify.get('/sync-limits', async (request, reply) => {
    // Basic protection
    const query = parseWithSchema(reply, maintenanceQuerySchema, request.query)
    if (!query) return
    const { key } = query
    if (key !== 'viewora-admin-sync') {
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
