import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

// ── Param schemas ─────────────────────────────────────────────
const hotspotParamsSchema = z.object({ hotspotId: z.string().uuid() })
const sceneParamsSchema   = z.object({ sceneId:   z.string().uuid() })

const CreateHotspotBodySchema = z.object({
  type: z.enum(['info', 'scene_link', 'url', 'video', 'youtube']),
  yaw: z.number().min(-180).max(180),
  pitch: z.number().min(-90).max(90),
  label: z.string().max(60).optional(),
  target_scene_id: z.string().uuid().optional().nullable(),
  content: z.object({
    text: z.string().max(500).optional(),
    image_url: z.string().url().optional(),
    url: z.string().url().optional(),
    icon: z.string().max(40).optional(),
    scale: z.number().min(0.1).max(5).optional(),
    hoverScale: z.number().min(1).max(5).optional(),
    corners: z.array(z.object({ yaw: z.number(), pitch: z.number() })).length(4).optional(),
    button_label: z.string().max(40).optional(),
  }).optional(),
}).refine(data => {
  if (data.type === 'scene_link' && !data.target_scene_id) return false
  if (data.type === 'url' && !data.content?.url) return false
  if (data.type === 'video' && !data.content?.url) return false
  if (data.type === 'youtube' && !data.content?.url) return false
  return true
}, { message: 'scene_link requires target_scene_id; url/video/youtube type requires content.url' })

// Standalone partial schema — avoids inheriting the .refine() from CreateHotspotBodySchema
// which would force scene_link/url constraints even on unrelated partial updates.
const UpdateHotspotBodySchema = z.object({
  type: z.enum(['info', 'scene_link', 'url', 'video', 'youtube']).optional(),
  yaw: z.number().min(-180).max(180).optional(),
  pitch: z.number().min(-90).max(90).optional(),
  label: z.string().max(60).optional().nullable(),
  target_scene_id: z.string().uuid().optional().nullable(),
  content: z.object({
    text: z.string().max(500).optional(),
    image_url: z.string().url().optional(),
    url: z.string().url().optional(),
    icon: z.string().max(40).optional(),
    scale: z.number().min(0.1).max(5).optional(),
    hoverScale: z.number().min(1).max(5).optional(),
    corners: z.array(z.object({ yaw: z.number(), pitch: z.number() })).length(4).optional(),
    button_label: z.string().max(40).optional(),
  }).optional().nullable(),
})

export default async function hotspotsRoutes(fastify: FastifyInstance) {

  // Helper: verify user owns the scene (via space ownership). Returns scene or null.
  async function verifySceneOwnership(sceneId: string, userId: string) {
    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('id, space_id')
      .eq('id', sceneId)
      .single()
    if (!scene) return null
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('user_id')
      .eq('id', scene.space_id)
      .single()
    if (!space || space.user_id !== userId) return null
    return scene
  }

  // ── LIST HOTSPOTS FOR A SCENE ──────────────────────────────
  fastify.get('/scenes/:sceneId/hotspots', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const scene = await verifySceneOwnership(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })
    const { data: hotspots } = await fastify.supabase
      .from('hotspots')
      .select('*')
      .eq('scene_id', params.sceneId)
      .order('created_at', { ascending: true })
    return reply.send({ hotspots: hotspots ?? [] })
  })

  // ── CREATE HOTSPOT ────────────────────────────────────────
  fastify.post('/scenes/:sceneId/hotspots', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateHotspotBodySchema, req.body)
    if (!body) return
    const scene = await verifySceneOwnership(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    // For scene_link: verify target belongs to the same space
    if (body.type === 'scene_link' && body.target_scene_id) {
      const { data: targetScene } = await fastify.supabase
        .from('scenes')
        .select('space_id')
        .eq('id', body.target_scene_id)
        .single()
      if (!targetScene || targetScene.space_id !== scene.space_id) {
        return reply.code(400).send({ statusMessage: 'Target scene must be in the same space' })
      }
    }

    const { data: hotspot, error } = await fastify.supabase
      .from('hotspots')
      .insert({ scene_id: params.sceneId, ...body })
      .select()
      .single()
    if (error) throw error
    return reply.code(201).send({ hotspot })
  })

  // ── UPDATE HOTSPOT ────────────────────────────────────────
  fastify.patch('/hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateHotspotBodySchema, req.body)
    if (!body) return

    const { data: hotspot } = await fastify.supabase
      .from('hotspots')
      .select('scene_id')
      .eq('id', params.hotspotId)
      .single()
    if (!hotspot) return reply.code(404).send({ statusMessage: 'Hotspot not found' })

    const scene = await verifySceneOwnership(hotspot.scene_id, userId)
    if (!scene) return reply.code(403).send({ statusMessage: 'Forbidden' })

    const { data: updated, error } = await fastify.supabase
      .from('hotspots')
      .update(body)
      .eq('id', params.hotspotId)
      .select()
      .single()
    if (error) throw error
    return reply.send({ hotspot: updated })
  })

  // ── DELETE HOTSPOT ────────────────────────────────────────
  fastify.delete('/hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParamsSchema, (req as any).params)
    if (!params) return

    const { data: hotspot } = await fastify.supabase
      .from('hotspots')
      .select('scene_id')
      .eq('id', params.hotspotId)
      .single()
    if (!hotspot) return reply.code(404).send({ statusMessage: 'Hotspot not found' })

    const scene = await verifySceneOwnership(hotspot.scene_id, userId)
    if (!scene) return reply.code(403).send({ statusMessage: 'Forbidden' })

    await fastify.supabase.from('hotspots').delete().eq('id', params.hotspotId)
    return reply.code(204).send()
  })
}
