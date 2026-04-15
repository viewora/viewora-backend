import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const TileCompleteBodySchema = z.object({
  sceneId: z.string().uuid(),
  tileManifestUrl: z.string().url().optional(),
  thumbnailUrl: z.string().url().optional(),
  status: z.enum(['ready', 'failed']),
})

export default async function internalRoutes(fastify: FastifyInstance) {

  // ── TILE COMPLETE CALLBACK ────────────────────────────────
  // Called by the tile worker when processing finishes.
  // Protected by WORKER_SECRET header — never exposed to users.
  fastify.post('/internal/tile-complete', async (req, reply) => {
    const workerSecret = (req.headers as any)['x-worker-secret']
    if (!process.env.WORKER_SECRET || workerSecret !== process.env.WORKER_SECRET) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const body = parseWithSchema(reply, TileCompleteBodySchema, req.body)
    if (!body) return

    const { error } = await fastify.supabase
      .from('scenes')
      .update({
        status: body.status,
        tile_manifest_url: body.tileManifestUrl ?? null,
        thumbnail_url: body.thumbnailUrl ?? null,
      })
      .eq('id', body.sceneId)

    if (error) throw error
    return reply.send({ ok: true })
  })
}
