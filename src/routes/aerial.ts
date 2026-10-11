import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'

// Aerial maps: flat drone photos with land shapes drawn on top (see
// VIEWORA_AERIAL_MAPS_MIGRATION.sql). Shapes are stored as one jsonb array
// per photo so the editor saves a whole edit with a single-row update.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const mapParams = z.object({ mapId: z.string().uuid() })

const safeUrl = z.string().url().refine(u => /^https?:\/\//i.test(u), { message: 'URL must use http or https' })
const linkUrl = z.string().max(2000).refine(u => {
  if (/^https?:\/\//i.test(u)) { try { new URL(u); return true } catch { return false } }
  return /^(tel:\+?[0-9\s\-()]{3,}|mailto:[^\s@]+@[^\s@]+)$/i.test(u)
}, { message: 'Link must be an http(s), tel: or mailto: URL' })

// Image-normalised coordinates; a little slack outside 0..1 lets a road arrow
// start just off the edge of the photo.
const point = z.object({ x: z.number().min(-0.5).max(1.5), y: z.number().min(-0.5).max(1.5) })

const ShapeSchema = z.object({
  id: z.string().min(1).max(64),
  // 'scene' = a 360 pin: where a 360 photo was taken; buyers tap it to stand there.
  kind: z.enum(['plot', 'zone', 'road', 'beacon', 'scene']),
  label: z.string().max(60).optional(),
  text: z.string().max(500).optional(),
  points: z.array(point).min(1).max(64),
  status: z.enum(['available', 'reserved', 'sold']).optional(),
  price: z.string().max(40).optional(),
  size: z.string().max(40).optional(),
  url: linkUrl.optional(),
  arrow_width: z.number().min(0.1).max(5).optional(),
  scene_id: z.string().uuid().optional(),
}).refine(s => {
  if (s.kind === 'scene') return !!s.scene_id
  if (s.kind === 'plot' || s.kind === 'zone') return s.points.length >= 3
  if (s.kind === 'road') return s.points.length >= 2
  return true
}, { message: 'Plots/outlines need 3+ points, roads 2+, 360 pins a linked 360' })

const CreateBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  image_url: safeUrl,
  media_id: z.string().uuid().optional().nullable(),
  width: z.number().int().min(1).max(20000).optional().nullable(),
  height: z.number().int().min(1).max(20000).optional().nullable(),
})

const IntroView = z.object({
  cx: z.number().min(-0.5).max(1.5),
  cy: z.number().min(-0.5).max(1.5),
  zoom: z.number().min(0.5).max(20),
})

const UpdateBody = z.object({
  // Buyer intro glide: start → end camera views (null = automatic).
  intro: z.object({ start: IntroView.optional(), end: IntroView.optional() }).nullable().optional(),
  title: z.string().trim().min(1).max(80).optional(),
  group_name: z.string().trim().max(40).transform(v => (v ? v : null)).nullable().optional(),
  order_index: z.number().int().min(0).max(1000).optional(),
  shapes: z.array(ShapeSchema).max(400).optional(),
})

// '*' rather than a column list: optional columns added by later migrations
// (e.g. group_name) must not break reads on databases that haven't run them.
const COLUMNS = '*'

export default async function aerialRoutes(fastify: FastifyInstance) {
  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }

  async function ownedMap(mapId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('aerial_maps')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', mapId)
      .eq('properties.user_id', userId)
      .maybeSingle()
    return data
  }

  // ── LIST (owner) ──────────────────────────────────────────
  fastify.get('/spaces/:spaceId/aerial-maps', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { data, error } = await fastify.supabase
      .from('aerial_maps').select(COLUMNS).eq('space_id', params.spaceId)
      .order('order_index', { ascending: true }).order('created_at', { ascending: true })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to load aerial maps' })
    }
    return reply.send({ aerial_maps: data ?? [] })
  })

  // ── CREATE ────────────────────────────────────────────────
  fastify.post('/spaces/:spaceId/aerial-maps', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { count } = await fastify.supabase
      .from('aerial_maps').select('id', { count: 'exact', head: true }).eq('space_id', params.spaceId)
    if ((count ?? 0) >= 20) return reply.code(400).send({ statusMessage: 'Up to 20 aerial photos per listing.' })

    const { data, error } = await fastify.supabase
      .from('aerial_maps')
      .insert({
        space_id: params.spaceId,
        title: body.title ?? 'Aerial view',
        image_url: body.image_url,
        media_id: body.media_id ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        order_index: count ?? 0,
      })
      .select(COLUMNS)
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to add aerial photo' })
    }

    // Aerial-only land listings need a cover for listing cards / link previews.
    await fastify.supabase.from('properties')
      .update({ cover_image_url: body.image_url })
      .eq('id', params.spaceId)
      .or('cover_image_url.is.null,cover_image_url.eq.""')

    return reply.code(201).send({ aerial_map: data })
  })

  // ── UPDATE (title / order / all shapes in one write) ─────
  fastify.patch('/aerial-maps/:mapId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, mapParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateBody, req.body)
    if (!body) return
    if (!(await ownedMap(params.mapId, userId))) return reply.code(404).send({ statusMessage: 'Aerial map not found' })

    const { data, error } = await fastify.supabase
      .from('aerial_maps')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.mapId)
      .select(COLUMNS)
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save aerial map' })
    }
    return reply.send({ aerial_map: data })
  })

  // ── DELETE ────────────────────────────────────────────────
  // The photo itself is removed by the client via DELETE /uploads/:mediaId,
  // which also frees the storage quota.
  fastify.delete('/aerial-maps/:mapId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, mapParams, (req as any).params)
    if (!params) return
    if (!(await ownedMap(params.mapId, userId))) return reply.code(404).send({ statusMessage: 'Aerial map not found' })
    const { error } = await fastify.supabase.from('aerial_maps').delete().eq('id', params.mapId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete aerial map' })
    return reply.code(204).send()
  })
}

/** Public, read-only: aerial maps for a published space (fetched fresh, not cached). */
export async function publicAerialMaps(fastify: FastifyInstance, spaceId: string) {
  const { data, error } = await fastify.supabase
    .from('aerial_maps')
    .select('*')
    .eq('space_id', spaceId)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: true })
  // Missing table (migration not run yet) must not break the public tour.
  if (error) return []
  return (data ?? []).map(({ space_id, media_id, ...rest }: any) => rest)
}

/**
 * Merges scenes.group_name into scene rows that came from get_tour_data()
 * (whose column list can't be changed from here). Missing column → no-op.
 */
export async function mergeSceneGroups(fastify: FastifyInstance, spaceId: string, scenes: any[] | null | undefined) {
  if (!Array.isArray(scenes) || !scenes.length) return
  const { data, error } = await fastify.supabase.from('scenes').select('id, group_name').eq('space_id', spaceId)
  if (error || !data) return
  const byId = new Map(data.map((r: any) => [r.id, r.group_name ?? null]))
  for (const s of scenes) if (byId.has(s.id)) s.group_name = byId.get(s.id)
}
