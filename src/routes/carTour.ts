import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { invalidateSpaceCache } from '../utils/cache.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { suggestCaptions } from '../utils/vehicleAi.js'
import { CHASSIS_RE, decodeVin, isDecodableVin, normalizeVin } from '../utils/vin.js'

// One car = one tour: exterior spins + interior 360s + named detail photos + the car's
// details. These routes tell the editor what is done and what is missing (the setup
// checklist), and name the detail photos the tour shows under each thumbnail.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const photoParams = z.object({ spaceId: z.string().uuid(), mediaId: z.string().uuid() })
export const CaptionBody = z.object({ caption: z.string().trim().max(40).nullable() })

const MAX_AI_CAPTION_PHOTOS = 24

const optText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform(v => (v === undefined ? undefined : v ? v : null))
export const IdentityBody = z.object({
  vin: z.string().nullable().optional()
    .transform(v => (v === undefined ? undefined : v ? normalizeVin(v) : null))
    .refine(v => v == null || CHASSIS_RE.test(v), { message: 'Use the 17-character VIN or the chassis number (letters, digits and hyphens)' }),
  make: optText(40),
  model: optText(60),
  trim: optText(60),
})
const vinParams = z.object({ vin: z.string().min(1).max(40) })

const IDENTITY_MIGRATION_MSG = "Saving the VIN, make and model needs a one-off database update: run migration-vehicle-identity.sql, then NOTIFY pgrst, 'reload schema';"

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

  // The car's identity: VIN or chassis number, make, model, trim. Its own route so the main
  // space save keeps working on a database without these columns yet.
  fastify.patch('/spaces/:spaceId/vehicle-identity', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, IdentityBody, req.body)
    if (!body) return
    const updates: Record<string, string | null> = {}
    if (body.vin !== undefined) updates.vehicle_vin = body.vin
    if (body.make !== undefined) updates.vehicle_make = body.make
    if (body.model !== undefined) updates.vehicle_model = body.model
    if (body.trim !== undefined) updates.vehicle_trim = body.trim
    if (!Object.keys(updates).length) return reply.code(400).send({ statusMessage: 'Nothing to save' })
    const { data, error } = await fastify.supabase.from('properties').update(updates)
      .eq('id', params.spaceId).eq('user_id', userId)
      .select('vehicle_vin, vehicle_make, vehicle_model, vehicle_trim').maybeSingle()
    if (error) {
      fastify.log.error(error)
      return reply.code(missingSchema(error) ? 503 : 500)
        .send({ statusMessage: missingSchema(error) ? IDENTITY_MIGRATION_MSG : 'Could not save the car details' })
    }
    if (!data) return reply.code(404).send({ statusMessage: 'Space not found' })
    await invalidateSpaceCache(fastify, params.spaceId)
    const row = data as any
    return reply.send({ vehicle: { vin: row.vehicle_vin, make: row.vehicle_make, model: row.vehicle_model, trim: row.vehicle_trim } })
  })

  // Make, model, trim, year, fuel and gearbox from a 17-character VIN (NHTSA vPIC, free).
  // Nothing is saved: the editor fills its fields and the owner checks them.
  fastify.get('/vehicle/vin/:vin', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const params = parseWithSchema(reply, vinParams, (req as any).params)
    if (!params) return
    const vin = normalizeVin(params.vin)
    if (!isDecodableVin(vin)) {
      return reply.code(422).send({
        statusMessage: vin.length === 17
          ? 'A VIN never uses the letters I, O or Q: check for a 1 or 0.'
          : 'Only a 17-character VIN can be looked up. Chassis numbers (common on Japanese imports) are saved as typed: fill in the make and model yourself.',
      })
    }
    let decoded
    try { decoded = await decodeVin(vin) } catch (err: any) {
      fastify.log.warn({ err: err.message }, '[vin decode] failed')
      return reply.code(502).send({ statusMessage: 'The VIN lookup is not answering right now. Fill in the details yourself or try again shortly.' })
    }
    if (!decoded) return reply.code(404).send({ statusMessage: 'No match for this VIN. Check it, or fill in the details yourself.' })
    return reply.send({ vehicle: decoded })
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
