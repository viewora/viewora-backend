import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { commandOptions } from 'redis'
import { parseWithSchema } from '../utils/validation.js'

const tileParamsSchema = z.object({
  sceneId: z.string().uuid(),
  col: z.string().regex(/^\d+$/),
  row: z.string().regex(/^\d+$/),
  ext: z.enum(['webp', 'jpg', 'jpeg']),
})

const spaceTileParamsSchema = tileParamsSchema.extend({
  spaceId: z.string().uuid(),
})

export default async function tilesRoutes(fastify: FastifyInstance) {
  // Handler for both full and medium tiles
  const handleTileRequest = async (req: any, reply: any, isMedium: boolean, hasSpaceId: boolean = false) => {
    const schema = hasSpaceId ? spaceTileParamsSchema : tileParamsSchema
    const params = parseWithSchema(reply, schema, req.params)
    if (!params) return

    const { sceneId, col, row, ext } = params
    let spaceId = hasSpaceId ? (params as any).spaceId : null
    
    if (!spaceId) {
      // Check if this scene belongs to a space and get spaceId
      const sceneSpaceKey = `scene-space:${sceneId}`
      spaceId = fastify.redis ? await fastify.redis.get(sceneSpaceKey) : null

      if (!spaceId) {
        const { data: scene } = await fastify.supabase
          .from('scenes')
          .select('space_id')
          .eq('id', sceneId)
          .single()
        
        if (!scene) {
          return reply.code(404).send({ statusMessage: 'Scene not found' })
        }
        spaceId = scene.space_id
        if (fastify.redis && spaceId) {
          await fastify.redis.setEx(sceneSpaceKey, 86400, spaceId)
        }
      }
    }

    const tileKey = `tile:${sceneId}:${col}:${row}:${ext}:${isMedium ? 'medium' : 'full'}`
    
    // 1. Try Redis Cache
    if (fastify.redis && fastify.redis.isOpen) {
      try {
        const cached = await fastify.redis.get(
          commandOptions({ returnBuffers: true }),
          tileKey
        )
        
        if (cached) {
          reply.header('Content-Type', `image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext}`)
          reply.header('Cache-Control', 'public, max-age=31536000, immutable')
          reply.header('X-Cache', 'HIT')
          return reply.send(cached)
        }
      } catch (err) {
        fastify.log.error({ err, tileKey }, 'Redis tile cache read error')
      }
    }

    // 2. Fetch from R2
    const bucket = process.env.R2_BUCKET_NAME!
    const folder = isMedium ? 'tiles_medium' : 'tiles'
    // Try webp first (legacy scenes + all new scenes), fall back to jpg for any recently
    // processed scenes that were uploaded between the webp revert and this change
    const keysToTry = [
      `spaces/${spaceId}/scenes/${sceneId}/${folder}/${col}_${row}.webp`,
      `spaces/${spaceId}/scenes/${sceneId}/${folder}/${col}_${row}.jpg`,
    ]

    for (const r2Key of keysToTry) {
      try {
        const response = await fastify.s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: r2Key,
        }))
        const { Body, ContentType } = response

        if (!Body) continue

        const buffer = Buffer.from(await Body.transformToUint8Array())

        // 3. Cache in Redis
        if (fastify.redis && fastify.redis.isOpen) {
          await fastify.redis.setEx(tileKey, 86400, buffer as any).catch(err => {
            fastify.log.error({ err, tileKey }, 'Failed to cache tile in Redis')
          })
        }

        reply.header('Content-Type', ContentType || 'image/jpeg')
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
        reply.header('X-Cache', 'MISS')
        return reply.send(buffer)
      } catch (err: any) {
        if (err.name === 'NoSuchKey') continue
        fastify.log.error({ err, r2Key }, 'Failed to fetch tile from R2')
        return reply.code(500).send({ statusMessage: 'Failed to fetch tile' })
      }
    }

    return reply.code(404).send({ statusMessage: 'Tile not found' })
  }

  fastify.get('/tiles/:sceneId/:filename', async (req: any, reply) => {
    const { sceneId, filename } = req.params
    const [colRow, ext] = filename.split('.')
    const [col, row] = colRow ? colRow.split('_') : []
    req.params = { sceneId, col, row, ext }
    return handleTileRequest(req, reply, false)
  })

  fastify.get('/tiles-medium/:sceneId/:filename', async (req: any, reply) => {
    const { sceneId, filename } = req.params
    const [colRow, ext] = filename.split('.')
    const [col, row] = colRow ? colRow.split('_') : []
    req.params = { sceneId, col, row, ext }
    return handleTileRequest(req, reply, true)
  })

  // Full path variants (to match legacy and explicit frontend requests)
  fastify.get('/spaces/:spaceId/scenes/:sceneId/tiles/:filename', async (req: any, reply) => {
    const { spaceId, sceneId, filename } = req.params
    const [colRow, ext] = filename.split('.')
    const [col, row] = colRow ? colRow.split('_') : []
    req.params = { spaceId, sceneId, col, row, ext }
    return handleTileRequest(req, reply, false, true)
  })

  fastify.get('/spaces/:spaceId/scenes/:sceneId/tiles_medium/:filename', async (req: any, reply) => {
    const { spaceId, sceneId, filename } = req.params
    const [colRow, ext] = filename.split('.')
    const [col, row] = colRow ? colRow.split('_') : []
    req.params = { spaceId, sceneId, col, row, ext }
    return handleTileRequest(req, reply, true, true)
  })
}
