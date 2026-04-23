import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

// ── Param schemas ─────────────────────────────────────────────
const sceneParamsSchema = z.object({ sceneId: z.string().uuid() })
const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

// ── Body schemas ─────────────────────────────────────────────
const CreateSceneBodySchema = z.object({
  name: z.string().min(1).max(100).default('Untitled Scene'),
  order_index: z.number().int().min(0).optional(),
  raw_image_url: z.string().url('Invalid image URL'),
  initial_yaw: z.number().min(-180).max(180).default(0),
  initial_pitch: z.number().min(-90).max(90).default(0),
})

// Explicit update schema.
// raw_image_url excluded: changing it without re-tiling corrupts state.
// status excluded: only the tile worker may change it.
const UpdateSceneBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  order_index: z.number().int().min(0).optional(),
  initial_yaw: z.number().min(-180).max(180).optional(),
  initial_pitch: z.number().min(-90).max(90).optional(),
})

export default async function scenesRoutes(fastify: FastifyInstance) {

  // ── LIST SCENES FOR A SPACE ────────────────────────────────
  fastify.get('/spaces/:spaceId/scenes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { data: scenes, error } = await fastify.supabase
      .from('scenes')
      .select('*, hotspots(*)')
      .eq('space_id', params.spaceId)
      .order('order_index', { ascending: true })

    if (error) throw error
    return reply.send({ scenes: scenes ?? [] })
  })

  // ── CREATE SCENE ──────────────────────────────────────────
  fastify.post('/spaces/:spaceId/scenes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateSceneBodySchema, req.body)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    // Auto-assign next order_index if not supplied
    const { data: lastScene } = await fastify.supabase
      .from('scenes')
      .select('order_index')
      .eq('space_id', params.spaceId)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle()

    const orderIndex = body.order_index ?? ((lastScene?.order_index ?? -1) + 1)

    const { data: scene, error: insertError } = await fastify.supabase
      .from('scenes')
      .insert({
        space_id: params.spaceId,
        name: body.name,
        order_index: orderIndex,
        raw_image_url: body.raw_image_url,
        initial_yaw: body.initial_yaw,
        initial_pitch: body.initial_pitch,
        status: 'pending',
      })
      .select()
      .single()

    if (insertError) throw insertError

    // Enqueue tiling job on the existing uploadQueue
    if (fastify.uploadQueue) {
      await fastify.uploadQueue.add('tile-scene', {
        sceneId: scene.id,
        rawImageUrl: body.raw_image_url,
        spaceId: params.spaceId,
        userId,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }

    return reply.code(201).send({ scene })
  })

  // ── GET SINGLE SCENE WITH HOTSPOTS ────────────────────────
  fastify.get('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return

    // Verify ownership BEFORE loading scene data — avoids loading potentially large
    // hotspot arrays for scenes the requester doesn't own.
    const { data: ownerCheck } = await fastify.supabase
      .from('scenes')
      .select('id, properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!ownerCheck) return reply.code(404).send({ statusMessage: 'Scene not found' })

    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('*, hotspots(*)')
      .eq('id', params.sceneId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    return reply.send({ scene })
  })

  // ── UPDATE SCENE ──────────────────────────────────────────
  fastify.patch('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateSceneBodySchema, req.body)
    if (!body) return

    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('id, properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    const { data: updated, error: updateError } = await fastify.supabase
      .from('scenes')
      .update(body)
      .eq('id', params.sceneId)
      .select()
      .single()

    if (updateError) throw updateError
    return reply.send({ scene: updated })
  })

  // ── DELETE SCENE ──────────────────────────────────────────
  // Hotspots are deleted automatically via CASCADE
  fastify.delete('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return

    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('id, properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    await fastify.supabase.from('scenes').delete().eq('id', params.sceneId)
    return reply.code(204).send()
  })
}
