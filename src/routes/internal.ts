import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { generateSpaceFloorPlan } from '../utils/floor-plan-generator.js'

const TileCompleteBodySchema = z.object({
  sceneId: z.string().uuid(),
  tileManifestUrl: z.string().url().optional(),
  thumbnailUrl: z.string().url().optional(),
  status: z.enum(['ready', 'failed']),
})

/**
 * Polygon from HorizonNet (or any room-layout AI service).
 * Coordinates are in "room units" where 1 unit ≈ STEP/4 canvas-px in the SVG
 * generator (roughly: 1 unit = ~2.5 m for a typical residential room).
 * The generating service must normalise its output to this scale.
 */
const RoomLayoutBodySchema = z.object({
  polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
})

export default async function internalRoutes(fastify: FastifyInstance) {

  // ── TILE COMPLETE CALLBACK ────────────────────────────────
  // Called by the tile worker when processing finishes.
  // Protected by WORKER_SECRET header — never exposed to users.
  fastify.post('/internal/tile-complete', async (req, reply) => {
    const workerSecret = (req.headers as any)['x-worker-secret']
    let authorized = false
    try {
      if (process.env.WORKER_SECRET && typeof workerSecret === 'string' && workerSecret.length === process.env.WORKER_SECRET.length) {
        authorized = timingSafeEqual(Buffer.from(workerSecret), Buffer.from(process.env.WORKER_SECRET))
      }
    } catch {
      authorized = false
    }
    if (!authorized) {
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

  /**
   * Tier-2 room layout hook — called by the HorizonNet inference service.
   *
   * Flow:
   *   1. HorizonNet Python service processes the raw panorama after it is tiled.
   *   2. It estimates the room polygon and POSTs it here.
   *   3. We store the polygon on the scene (room_layout_json).
   *   4. We re-generate the space floor plan — this scene now uses the real polygon
   *      while any scenes without a layout still use the Tier-1 estimate.
   *
   * Auth: same WORKER_SECRET header used by the tile-complete callback.
   * Idempotent: calling multiple times with improved polygons just overwrites.
   */
  fastify.post('/internal/scenes/:sceneId/room-layout', async (req, reply) => {
    const workerSecret = (req.headers as any)['x-worker-secret']
    let authorized = false
    try {
      if (
        process.env.WORKER_SECRET &&
        typeof workerSecret === 'string' &&
        workerSecret.length === process.env.WORKER_SECRET.length
      ) {
        authorized = timingSafeEqual(
          Buffer.from(workerSecret),
          Buffer.from(process.env.WORKER_SECRET),
        )
      }
    } catch { authorized = false }

    if (!authorized) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const { sceneId } = req.params as { sceneId: string }
    if (!sceneId?.match(/^[0-9a-f-]{36}$/i)) {
      return reply.code(400).send({ statusMessage: 'Invalid sceneId' })
    }

    const body = parseWithSchema(reply, RoomLayoutBodySchema, req.body)
    if (!body) return

    // Fetch scene to get its space_id
    const { data: scene, error: fetchErr } = await fastify.supabase
      .from('scenes')
      .select('id, space_id')
      .eq('id', sceneId)
      .single()

    if (fetchErr || !scene) {
      return reply.code(404).send({ statusMessage: 'Scene not found' })
    }

    // Persist the room polygon
    const { error: updateErr } = await fastify.supabase
      .from('scenes')
      .update({ room_layout_json: body.polygon })
      .eq('id', sceneId)

    if (updateErr) {
      fastify.log.error(updateErr, 'Failed to store room_layout_json')
      return reply.code(500).send({ statusMessage: 'Failed to store room layout' })
    }

    fastify.log.info({ sceneId, spaceId: scene.space_id, points: body.polygon.length },
      '[internal] Room layout stored — regenerating floor plan')

    // Re-generate the floor plan for the whole space (non-blocking)
    const cdnBase = process.env.MEDIA_DOMAIN
      || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

    void generateSpaceFloorPlan(
      fastify.s3,
      fastify.supabase,
      scene.space_id,
      cdnBase,
    ).catch(err => fastify.log.error(err, '[internal] Floor plan regeneration failed'))

    return reply.send({ ok: true, sceneId, spaceId: scene.space_id })
  })
}
