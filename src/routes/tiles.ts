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

export default async function tilesRoutes(fastify: FastifyInstance) {
  // Handler for both full and medium tiles
  const handleTileRequest = async (req: any, reply: any, isMedium: boolean) => {
    const params = parseWithSchema(reply, tileParamsSchema, req.params)
    if (!params) return

    const { sceneId, col, row, ext } = params
    
    // Check if this scene belongs to a space and get spaceId
    const sceneSpaceKey = `scene-space:${sceneId}`
    let spaceId = fastify.redis ? await fastify.redis.get(sceneSpaceKey) : null

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
    let s3Key = `spaces/${spaceId}/scenes/${sceneId}/${folder}/${col}_${row}.${ext}`
    let bodyData: any = null
    let responseContentType = `image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext}`

    try {
      const response = await fastify.s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      }))
      bodyData = response.Body
      if (response.ContentType) responseContentType = response.ContentType
    } catch (err: any) {
      if (err.name === 'NoSuchKey' && ext === 'webp') {
        s3Key = `spaces/${spaceId}/scenes/${sceneId}/${folder}/${col}_${row}.jpg`
        try {
          const fallback = await fastify.s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: s3Key,
          }))
          bodyData = fallback.Body
          responseContentType = fallback.ContentType || 'image/jpeg'
        } catch (fallbackErr: any) {
          if (fallbackErr.name === 'NoSuchKey') {
            return reply.code(404).send({ statusMessage: 'Tile not found' })
          }
          fastify.log.error({ err: fallbackErr, s3Key }, 'Failed to fetch tile from R2')
          return reply.code(500).send({ statusMessage: 'Failed to fetch tile' })
        }
      } else if (err.name === 'NoSuchKey') {
        return reply.code(404).send({ statusMessage: 'Tile not found' })
      } else {
        fastify.log.error({ err, s3Key }, 'Failed to fetch tile from R2')
        return reply.code(500).send({ statusMessage: 'Failed to fetch tile' })
      }
    }

    if (!bodyData) {
      return reply.code(404).send({ statusMessage: 'Tile not found in storage' })
    }

    try {
      const buffer = Buffer.from(await bodyData.transformToUint8Array())

      // 3. Cache in Redis
      if (fastify.redis && fastify.redis.isOpen) {
        // Cache for 24 hours (tiles are immutable)
        await fastify.redis.setEx(tileKey, 86400, buffer as any).catch(err => {
          fastify.log.error({ err, tileKey }, 'Failed to cache tile in Redis')
        })
      }

      reply.header('Content-Type', responseContentType)
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      reply.header('X-Cache', 'MISS')
      return reply.send(buffer)
    } catch (err: any) {
      fastify.log.error({ err, s3Key }, 'Failed to process tile from R2')
      return reply.code(500).send({ statusMessage: 'Failed to process tile' })
    }
  }

  fastify.get('/tiles/:sceneId/:col_:row.:ext', async (req, reply) => {
    return handleTileRequest(req, reply, false)
  })

  fastify.get('/tiles-medium/:sceneId/:col_:row.:ext', async (req, reply) => {
    return handleTileRequest(req, reply, true)
  })
}
