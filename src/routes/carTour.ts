import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { invalidateSpaceCache } from '../utils/cache.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { suggestCaptions } from '../utils/vehicleAi.js'

// One car = one tour: exterior spins + interior 360s + named detail photos + the car's
// details. These routes tell the editor what is done and what is missing (the setup
// checklist), and name the detail photos the tour shows under each thumbnail.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const photoParams = z.object({ spaceId: z.string().uuid(), mediaId: z.string().uuid() })
export const CaptionBody = z.object({ caption: z.string().trim().max(40).nullable() })

const MAX_AI_CAPTION_PHOTOS = 24

function missingSchema(error: { code?: string; message?: string } | null | undefined) {
  return !!error && /PGRST20[0-9]|42P01|42703|schema cache|does not exist|Could not find/i.test(`${error.code ?? ''} ${error.message ?? ''}`)
}

/**
 * Gallery photos with their names. Before migration-car-tour-photos.sql has run there is no
 * caption column: the photos still come back, unnamed (`captionsReady` false).
 */
export async function galleryWithCaptions(fastify: FastifyInstance, spaceId: string, onlyComplete = true) {
  const base = () => {
    let q = fastify.supabase.from('property_media').select('id, public_url, is_primary, sort_order, processing_status')
      .eq('property_id', spaceId).eq('media_type', 'gallery_image')
    if (onlyComplete) q = q.eq('processing_status', 'complete')
    return q.order('is_primary', { ascending: false }).order('sort_order', { ascending: true })
  }
  const { data, error } = await base()
  if (error) return { photos: [] as any[], captionsReady: false }
  const rows = (data ?? []) as any[]
  if (!rows.length) return { photos: [], captionsReady: true }
  const caps = await fastify.supabase.from('property_media').select('id, caption').in('id', rows.map(r => r.id))
  const captionsReady = !caps.error
  const byId = new Map<string, string | null>(((caps.data ?? []) as any[]).map(c => [c.id, c.caption ?? null]))
  return {
    photos: rows.map(r => ({ id: r.id, url: r.public_url, caption: byId.get(r.id) ?? null, processing_status: r.processing_status })),
    captionsReady,
  }
}

export default async function carTourRoutes(fastify: FastifyInstance) {
  async function ownedSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('*').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return data as any
  }

  // What the car tour has and what it still needs, for the editor's numbered steps and checklist.
  fastify.get('/spaces/:spaceId/car-setup', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const space = await ownedSpace(params.spaceId, userId)
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const [viewsRes, spinsRes, scenesRes, gallery] = await Promise.all([
      fastify.supabase.from('vehicle_views').select('*').eq('space_id', params.spaceId),
      fastify.supabase.from('vehicle_spins').select('id, title, start_angle, order_index')
        .eq('space_id', params.spaceId).order('order_index', { ascending: true }),
      fastify.supabase.from('scenes').select('id, name, thumbnail_url').eq('space_id', params.spaceId)
        .order('order_index', { ascending: true }),
      galleryWithCaptions(fastify, params.spaceId, false),
    ])
    const views = (viewsRes.data ?? []) as any[]
    const spinRows = spinsRes.error ? [] : ((spinsRes.data ?? []) as any[])
    const firstSpin = spinRows[0]?.id ?? null
    const spins = spinRows.length
      ? spinRows.map(s => ({ id: s.id, title: s.title, frames: views.filter(v => (v.spin_id ?? firstSpin) === s.id).length }))
      : (views.length ? [{ id: null, title: 'Exterior', frames: views.length }] : [])
    const scenes = ((scenesRes.data ?? []) as any[])

    return reply.send({
      title: space.title ?? '',
      slug: space.slug ?? null,
      is_published: !!space.is_published,
      spins,
      spins_ready: !spinsRes.error,
      interior_scenes: scenes.length,
      interior_ready: scenes.filter(s => s.thumbnail_url).length,
      detail_photos: gallery.photos,
      captions_ready: gallery.captionsReady,
      vehicle: {
        year: space.vehicle_year ?? null,
        mileage_km: space.vehicle_mileage_km ?? null,
        transmission: space.vehicle_transmission ?? null,
        fuel_type: space.vehicle_fuel_type ?? null,
        price_kes: space.price_kes ?? null,
        // Present once migration-vehicle-identity.sql has run (select('*') simply has no key before).
        vin: space.vehicle_vin ?? null,
        make: space.vehicle_make ?? null,
        model: space.vehicle_model ?? null,
        trim: space.vehicle_trim ?? null,
      },
    })
  })

  // Name one detail photo. Empty clears it.
  fastify.patch('/spaces/:spaceId/photos/:mediaId/caption', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, photoParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CaptionBody, req.body)
    if (!body) return
    if (!(await ownedSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const caption = body.caption?.trim() ? body.caption.trim() : null
    const { data, error } = await fastify.supabase
      .from('property_media').update({ caption })
      .eq('id', params.mediaId).eq('property_id', params.spaceId).eq('media_type', 'gallery_image')
      .select('id, caption').maybeSingle()
    if (error) {
      fastify.log.error(error)
      const msg = missingSchema(error)
        ? "Naming photos needs a one-off database update: run migration-car-tour-photos.sql, then NOTIFY pgrst, 'reload schema';"
        : 'Could not save the name'
      return reply.code(missingSchema(error) ? 503 : 500).send({ statusMessage: msg })
    }
    if (!data) return reply.code(404).send({ statusMessage: 'Photo not found' })
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.send({ photo: data })
  })

  // AI names every unnamed detail photo and saves the names (the owner can change any of them).
  fastify.post('/spaces/:spaceId/photos/ai-captions', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI is not configured on the server.' })
    if (!(await ownedSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { photos, captionsReady } = await galleryWithCaptions(fastify, params.spaceId)
    if (!captionsReady) {
      return reply.code(503).send({ statusMessage: "Naming photos needs a one-off database update: run migration-car-tour-photos.sql, then NOTIFY pgrst, 'reload schema';" })
    }
    const unnamed = photos.filter(p => !p.caption).slice(0, MAX_AI_CAPTION_PHOTOS)
    if (!unnamed.length) return reply.send({ captions: [] })

    let refund: () => Promise<void>
    try { refund = await consumeAi(fastify, userId, 'prompts') } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }
    let captions: Array<{ id: string; caption: string }>
    try {
      captions = await suggestCaptions(apiKey, unnamed.map(p => ({ id: p.id, url: p.url })))
    } catch (err: any) {
      fastify.log.warn({ err: err.message, spaceId: params.spaceId }, '[car ai-captions] failed')
      await refund().catch(() => {})
      return reply.code(502).send({ statusMessage: 'Could not name the photos right now. Try again shortly.' })
    }
    await Promise.all(captions.map(c => fastify.supabase.from('property_media').update({ caption: c.caption })
      .eq('id', c.id).eq('property_id', params.spaceId)))
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.send({ captions })
  })
}
