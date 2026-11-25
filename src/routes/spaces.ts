import { FastifyInstance } from 'fastify'
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { canCreateSpace, checkUserQuota, isTourLimitError, quotaLimitMessage } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'
import { sendTourPublishedEmail } from '../email/index.js'
import { invalidateSpaceCache, invalidateTourCache, purgeSceneTiles } from '../utils/cache.js'
import { randomUUID } from 'node:crypto'
import { sceneStoragePrefixes, filesStillUsed } from '../utils/sceneStorage.js'
import { generateListingDescription } from '../utils/aiDescription.js'
import { failureReason } from '../utils/gemini.js'
import { attachNadirCover, nadirCoverSchema, readNadirCover } from '../utils/nadirCover.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { sanitizeSocialLinks, SOCIAL_KEYS } from '../utils/socialLinks.js'
import { carCovers } from '../utils/carCover.js'

// Converts a space title into a URL-safe slug.
// "Modern 3-Bed Villa, Westlands" → "modern-3-bed-villa-westlands"
// Falls back to "tour-{id fragment}" when title is absent or too short.
function generateSlug(title: string | null | undefined, id: string): string {
  const base = (title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s-]/g, '')                     // keep alphanumeric + spaces + hyphens
    .trim()
    .replace(/[\s-]+/g, '-')                           // collapse spaces/hyphens
    .replace(/^-+|-+$/g, '')                           // trim leading/trailing hyphens
    .slice(0, 80)

  if (base.length >= 3) return base
  return `tour-${id.slice(0, 8)}`
}

const uuidSchema = z.string().uuid()

const idParamsSchema = z.object({
  id: uuidSchema,
})

const slugSchema = z.string().trim().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens')

// Shared with updateSpaceBodySchema below — the listing facts added for the
// buyer-facing redesign (VIEWORA_2_PRODUCT_SPEC.md §3.1). All optional at
// the DB level (see migration-add-listing-facts.sql) since existing rows
// predate these columns; "must have a price to appear in the Home feed" is
// enforced at the query level, not here.
const listingFactsSchema = {
  price_kes: z.number().int().positive().max(999_999_999_999).nullable().optional(),
  listing_status: z.enum(['available', 'sold', 'rented']).nullable().optional(),
  // Orthogonal to listing_status (which tracks current state) — this is the
  // fundamental nature of the listing. Without it, a price alone is
  // ambiguous (is KES 50,000 a sale price or monthly rent?). price_period
  // only means anything when transaction_type is 'rent'.
  // Nullable — the editor always sends this key (null when unset, e.g.
  // "Listing Type" left unpicked), not omitted, so a bare .optional() here
  // rejected every save with a VALIDATION_ERROR on transaction_type/
  // price_period even when the user never touched those fields.
  transaction_type: z.enum(['sale', 'rent']).nullable().optional(),
  price_period: z.enum(['day', 'week', 'month', 'year']).nullable().optional(),
  bedrooms: z.number().int().min(0).max(50).nullable().optional(),
  bathrooms: z.number().int().min(0).max(50).nullable().optional(),
  area_sqm: z.number().int().min(0).max(1_000_000).nullable().optional(),
  vehicle_year: z.number().int().min(1900).max(2100).nullable().optional(),
  vehicle_mileage_km: z.number().int().min(0).max(10_000_000).nullable().optional(),
  vehicle_transmission: z.enum(['manual', 'automatic']).nullable().optional(),
  vehicle_fuel_type: z.enum(['petrol', 'diesel', 'electric', 'hybrid']).nullable().optional(),
  land_acres: z.number().min(0).max(1_000_000).nullable().optional(),
  land_type: z.enum(['agricultural', 'commercial', 'residential']).nullable().optional(),
  amenities: z.array(z.string().trim().min(1).max(60)).max(30).nullable().optional(),
}

const createSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other', 'hospital']),
  description: z.string().max(2000).optional(),
  location_text: z.string().max(200).optional(),
  slug: slugSchema.optional(),
  // Set explicitly by conversation/orchestrator.ts for bot-created listings;
  // omitted (defaults to 'web') by the web editor's existing create call —
  // no frontend change needed to keep working correctly.
  created_via: z.enum(['web', 'telegram', 'whatsapp']).optional(),
  ...listingFactsSchema,
})

const updateSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  cover_image_url: z.string().url().max(2048).nullable().optional(),
  location_text: z.string().max(200).nullable().optional(),
  location_lat: z.number().min(-90).max(90).nullable().optional(),
  location_lng: z.number().min(-180).max(180).nullable().optional(),
  logo_url: z.string().url().max(2048).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  slug: slugSchema.nullable().optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other', 'hospital']).optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
  cta_enabled: z.boolean().optional(),
  cta_button_text: z.string().max(80).nullable().optional(),
  cta_action: z.enum(['link', 'email', 'phone']).nullable().optional(),
  cta_destination: z.string().max(2048).nullable().optional(),
  // { instagram: '@name' | link, ... } — cleaned to valid network links on save
  social_links: z.object(Object.fromEntries(SOCIAL_KEYS.map(k => [k, z.string().max(300).nullable().optional()]))).nullable().optional(),
  ...listingFactsSchema,
})

// Deliberately takes the CURRENT (possibly unsaved) editor draft as the
// request body rather than re-reading the DB — the owner may have just
// typed a new price/bed count and not hit Save Settings yet, and the
// description should reflect what's on screen, not stale saved values.
const generateDescriptionBodySchema = z.object({
  title: z.string().max(120).optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other', 'hospital']).optional(),
  location_text: z.string().max(200).optional(),
  ...listingFactsSchema,
})

// Move scenes (and the gallery photos the owner picks) into a new tour — see
// utils/migration-move-scenes.sql for exactly what moves and what is copied.
const moveScenesBodySchema = z.object({
  scene_ids: z.array(uuidSchema).min(1).max(1000),
  photo_ids: z.array(uuidSchema).max(1000).default([]),
  title: z.string().trim().min(1).max(120),
  // Publish the new tour at its own link straight away (the editor defaults this
  // to whether the source tour is live).
  publish: z.boolean().default(true),
})

// Copy or move scenes (and chosen photos) into another tour the owner already has —
// see utils/migration-add-scenes-to-tour.sql for exactly what is copied or moved.
const addScenesBodySchema = z.object({
  target_id: uuidSchema,
  scene_ids: z.array(uuidSchema).min(1).max(1000),
  photo_ids: z.array(uuidSchema).max(1000).default([]),
  // true: the scenes stay here too (shared common areas); false: they leave this tour.
  copy: z.boolean().default(true),
})

/** First free slug among base, base-2, base-3…, so the new tour gets a readable link. */
async function freeSlug(fastify: FastifyInstance, base: string): Promise<string> {
  const { data } = await fastify.supabase.from('properties').select('slug').like('slug', `${base}%`)
  const taken = new Set((data ?? []).map((r: any) => r.slug))
  if (!taken.has(base)) return base
  for (let i = 2; i < 200; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${randomUUID().slice(0, 6)}`
}

const updateSettingsBodySchema = z.object({
  hfov_default: z.number().min(30).max(120).optional(),
  yaw_default: z.number().min(-180).max(180).optional(),
  pitch_default: z.number().min(-90).max(90).optional(),
  auto_rotate_enabled: z.boolean().optional(),
  // Tripod cover; null turns it off. Saved on its own by the editor, so a database
  // without the column (migration-nadir-cover.sql) only fails this one save.
  nadir_cover: nadirCoverSchema.nullable().optional(),
})

const publishBodySchema = z.object({
  publish: z.boolean(),
  slug: z.string().trim().min(3).max(120).nullable().optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
})

export default async function (fastify: FastifyInstance) {
  // GET all user spaces
  fastify.get('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const query = request.query as { page?: string; limit?: string }
    const limit = Math.min(Number(query.limit) || 100, 200)
    const page = Math.max(Number(query.page) || 1, 1)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, error, count } = await fastify.supabase
      .from('properties')
      .select('id, title, slug, description, property_type, location_text, location_lat, location_lng, logo_url, phone, email, cover_image_url, has_360, has_gallery, is_published, visibility, lead_form_enabled, branding_enabled, price_kes, listing_status, transaction_type, price_period, bedrooms, bathrooms, area_sqm, vehicle_year, vehicle_mileage_km, vehicle_transmission, vehicle_fuel_type, land_acres, land_type, amenities, view_count, claim_state, created_via, created_at, updated_at, scenes ( thumbnail_url, order_index ), property_media ( public_url, media_type, sort_order, is_primary, processing_status )', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch spaces' })
    }

    // The Tours dashboard card needs a thumbnail even for gallery-only
    // listings — cover_image_url on the row is only ever written by the
    // 360 tile pipeline (tile-processor.ts), so a flat-photo listing has it
    // null forever otherwise. Same fallback chain as listingMapper.ts's
    // public-facing mapRow: scene thumbnail, then first processed gallery
    // photo, then the raw column.
    const mappedData = (data || []).map((d: any) => {
      const sceneThumb = (d.scenes || [])
        .filter((s: any) => s.thumbnail_url)
        .sort((a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0))[0]?.thumbnail_url

      const galleryPhoto = (d.property_media || [])
        .filter((m: any) => m.media_type === 'gallery_image' && m.processing_status === 'complete' && m.public_url)
        .sort((a: any, b: any) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]?.public_url

      return {
        ...d,
        space_type: d.property_type,
        property_type: undefined,
        cover_image_url: sceneThumb || galleryPhoto || d.cover_image_url || null,
        scenes: undefined,
        property_media: undefined,
      }
    })

    // A car's card shows the car from the front (its spin's start frame), not the first interior 360.
    const covers = await carCovers(fastify, mappedData.filter((d: any) => d.space_type === 'automotive').map((d: any) => d.id))
    for (const d of mappedData) if (covers.has(d.id)) d.cover_image_url = covers.get(d.id)

    // A car with only its exterior spin has no scene or gallery photo: its card shows the
    // first frame of the spin. At most a few rows per car (the frames at the start), and a failed lookup only
    // leaves those cards without a picture, never fails the list.
    const bare = mappedData.filter((d: any) => !d.cover_image_url).map((d: any) => d.id)
    if (bare.length) {
      const { data: frames } = await fastify.supabase
        .from('vehicle_views').select('space_id, image_url, created_at')
        .in('space_id', bare).lt('order_index', 8)
        .order('order_index', { ascending: true }).order('created_at', { ascending: true })
      const first = new Map<string, string>()
      for (const f of frames || []) if (f.image_url && !first.has(f.space_id)) first.set(f.space_id, f.image_url)
      for (const d of mappedData) if (!d.cover_image_url && first.has(d.id)) d.cover_image_url = first.get(d.id)
    }

    return reply.send({ data: mappedData, total: count ?? 0, page, limit })
  })

  // GET specific space
  fastify.get('/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data, error } = await fastify.supabase
      .from('properties')
      .select(`
        id, title, slug, description, property_type, location_text, location_lat, location_lng,
        logo_url, phone, email, cover_image_url, has_360, has_gallery, is_published, published_at,
        visibility, lead_form_enabled, branding_enabled,
        cta_enabled, cta_button_text, cta_action, cta_destination, social_links,
        claim_state, created_via,
        price_kes, listing_status, transaction_type, price_period,
        bedrooms, bathrooms, area_sqm,
        vehicle_year, vehicle_mileage_km, vehicle_transmission, vehicle_fuel_type,
        land_acres, land_type, amenities,
        created_at, updated_at,
        property_media (id, media_type, storage_key, public_url, width, height, file_size_bytes, sort_order, is_primary, processing_status, processed_at, processing_error, created_at, updated_at),
        property_360_settings (id, panorama_media_id, hfov_default, pitch_default, yaw_default, auto_rotate_enabled, hotspots_json)
      `)
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (error) {
      return reply.code(404).send({ statusMessage: 'Space not found' })
    }

    const mappedSpace = {
      ...data,
      space_type: data.property_type,
      property_type: undefined
    }
    // Own query: a database without the column still opens the editor.
    attachNadirCover(mappedSpace, await readNadirCover(fastify, id))

    return reply.send(mappedSpace)
  })

  // CREATE space
  fastify.post('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = parseWithSchema(reply, createSpaceBodySchema, request.body)
    if (!body) return

    // 1. Subscription + quota check (single checkUserQuota call — passed into canCreateSpace)
    const quotaCtx = await checkUserQuota(fastify, userId)
    if (quotaCtx.isGrace) {
      return reply.code(403).send({ statusMessage: 'Space creation is disabled during the grace period. Please renew your subscription.' })
    }
    if (!quotaCtx.canWrite) {
      return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
    }
    const tourLimitReply = () => reply.code(403).send({
      statusMessage: quotaLimitMessage(quotaCtx.plan, 'tours'),
      code: 'TOUR_LIMIT_REACHED',
      limit: quotaCtx.plan.max_active_spaces,
      plan: quotaCtx.plan.name,
    })
    if (!(await canCreateSpace(fastify, userId, quotaCtx))) return tourLimitReply()

    // 2. Create space
    const { data: space, error } = await fastify.supabase
      .from('properties')
      .insert({
        user_id: userId,
        title: body.title,
        description: body.description || null,
        slug: body.slug || null,
        property_type: body.space_type,
        location_text: body.location_text || null,
        price_kes: body.price_kes,
        listing_status: body.listing_status,
        transaction_type: body.transaction_type,
        price_period: body.price_period,
        bedrooms: body.bedrooms,
        bathrooms: body.bathrooms,
        area_sqm: body.area_sqm,
        vehicle_year: body.vehicle_year,
        vehicle_mileage_km: body.vehicle_mileage_km,
        vehicle_transmission: body.vehicle_transmission,
        vehicle_fuel_type: body.vehicle_fuel_type,
        land_acres: body.land_acres,
        land_type: body.land_type,
        amenities: body.amenities,
        created_via: body.created_via ?? 'web',
        // Anonymous sessions (both the web claim flow and every bot
        // conversation — see conversation/anonymousAuth.ts) are the only
        // creators who don't yet have a real, non-anonymous account behind
        // this listing. A normal logged-in user's listing is 'claimed' from
        // the moment it's created, since there's nothing left to claim.
        claim_state: user.is_anonymous ? 'unclaimed' : 'claimed',
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return reply.code(409).send({ statusMessage: 'This URL slug is already in use. Please choose another one.' })
      }
      // Lost a race with a parallel create: the DB trigger is the authoritative limit check.
      if (isTourLimitError(error)) return tourLimitReply()
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to create space' })
    }

    const mappedSpace = {
      ...space,
      space_type: space.property_type,
      property_type: undefined
    }

    // 3. usage_counters.active_properties_count is recounted by a DB trigger
    //    (migration-tour-quota-enforcement.sql) — no RPC call here.

    // Bust billing cache so frontend sees the updated usage count immediately
    if (fastify.redis) {
      await fastify.redis.del(`billing:status:${userId}`).catch(() => {})
    }

    return reply.code(201).send(mappedSpace)
  })

  // UPDATE space
  fastify.patch('/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params
    const body = parseWithSchema(reply, updateSpaceBodySchema, request.body)
    if (!body) return

    const updates: any = {}
    if (body.title !== undefined) updates.title = body.title
    if (body.description !== undefined) updates.description = body.description
    if (body.cover_image_url !== undefined) updates.cover_image_url = body.cover_image_url
    if (body.location_text !== undefined) updates.location_text = body.location_text
    if (body.location_lat !== undefined) updates.location_lat = body.location_lat
    if (body.location_lng !== undefined) updates.location_lng = body.location_lng
    if (body.logo_url !== undefined) updates.logo_url = body.logo_url
    if (body.phone !== undefined) updates.phone = body.phone
    if (body.email !== undefined) updates.email = body.email
    if (body.cta_enabled !== undefined) updates.cta_enabled = body.cta_enabled
    if (body.cta_button_text !== undefined) updates.cta_button_text = body.cta_button_text
    if (body.cta_action !== undefined) updates.cta_action = body.cta_action
    if (body.cta_destination !== undefined) updates.cta_destination = body.cta_destination
    if (body.social_links !== undefined) updates.social_links = body.social_links ? sanitizeSocialLinks(body.social_links) : {}
    if (body.space_type !== undefined) updates.property_type = body.space_type
    if (body.lead_form_enabled !== undefined) updates.lead_form_enabled = body.lead_form_enabled
    if (body.branding_enabled !== undefined) updates.branding_enabled = body.branding_enabled
    if (body.slug !== undefined) updates.slug = body.slug
    if (body.price_kes !== undefined) updates.price_kes = body.price_kes
    if (body.listing_status !== undefined) updates.listing_status = body.listing_status
    if (body.transaction_type !== undefined) updates.transaction_type = body.transaction_type
    if (body.price_period !== undefined) updates.price_period = body.price_period
    if (body.bedrooms !== undefined) updates.bedrooms = body.bedrooms
    if (body.bathrooms !== undefined) updates.bathrooms = body.bathrooms
    if (body.area_sqm !== undefined) updates.area_sqm = body.area_sqm
    if (body.vehicle_year !== undefined) updates.vehicle_year = body.vehicle_year
    if (body.vehicle_mileage_km !== undefined) updates.vehicle_mileage_km = body.vehicle_mileage_km
    if (body.vehicle_transmission !== undefined) updates.vehicle_transmission = body.vehicle_transmission
    if (body.vehicle_fuel_type !== undefined) updates.vehicle_fuel_type = body.vehicle_fuel_type
    if (body.land_acres !== undefined) updates.land_acres = body.land_acres
    if (body.land_type !== undefined) updates.land_type = body.land_type
    if (body.amenities !== undefined) updates.amenities = body.amenities

    // A new link (slug): remember the old one, whose cached tour must be cleared too —
    // invalidateSpaceCache() below only knows the new slug.
    let previousSlug: string | null = null
    if (updates.slug !== undefined) {
      const { data: current } = await fastify.supabase
        .from('properties').select('slug').eq('id', id).eq('user_id', userId).maybeSingle()
      previousSlug = current?.slug ?? null
    }

    const { data: space, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') return reply.code(404).send({ statusMessage: 'Space not found' })
      if (error.code === '23505') return reply.code(409).send({ statusMessage: 'That link is already used by another tour. Please choose another one.' })
      return reply.code(500).send({ statusMessage: 'Failed to update space' })
    }
    if (previousSlug && previousSlug !== space.slug) await invalidateTourCache(fastify, id, previousSlug)

    const mappedSpace = {
      ...space,
      space_type: space.property_type,
      property_type: undefined
    }

    // Invalidate public cache
    await invalidateSpaceCache(fastify, id)

    return reply.send(mappedSpace)
  })

  // DELETE space
  fastify.delete('/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    // 1. Get all media and scenes for this space before deleting
    const [
      { data: mediaItems, error: mediaFetchErr },
      { data: sceneItems },
    ] = await Promise.all([
      fastify.supabase
        .from('property_media')
        .select('id, media_type, public_url, storage_key, file_size_bytes, properties!inner(user_id)')
        .eq('property_id', id)
        .eq('properties.user_id', userId),
      fastify.supabase
        .from('scenes')
        .select('id, space_id, thumbnail_url, tile_manifest_url, tile_medium_manifest_url')
        .eq('space_id', id),
    ])

    if (mediaFetchErr) {
      return reply.code(500).send({ statusMessage: 'Failed to load space media' })
    }

    // 1b. Panorama uploads that a scene in ANOTHER tour still shows (a copy made with
    // "Add to existing tour") go to that tour instead of being deleted with this one.
    const handedOver = new Set<string>()
    for (const m of (mediaItems ?? []) as any[]) {
      if (m.media_type !== 'panorama' || !m.public_url) continue
      const { data: heir } = await fastify.supabase
        .from('scenes').select('space_id')
        .neq('space_id', id)
        .or(`raw_image_url.eq."${m.public_url}",original_raw_image_url.eq."${m.public_url}"`)
        .limit(1).maybeSingle()
      if (!heir?.space_id) continue
      const { error: moveErr } = await fastify.supabase.from('property_media').update({ property_id: heir.space_id }).eq('id', m.id)
      if (!moveErr) handedOver.add(m.id)
    }
    const ownMedia = ((mediaItems ?? []) as any[]).filter(m => !handedOver.has(m.id))

    // 2. Delete DB record first — if this fails we abort before touching R2.
    // R2 cleanup after a successful DB delete is best-effort; orphan scheduler recovers leftovers.
    const { error } = await fastify.supabase
      .from('properties')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to delete space' })
    }

    // 3. Cleanup R2 — property_media objects (best-effort after confirmed DB delete)
    const bucketName = process.env.R2_BUCKET_NAME
    // Files a copy in another tour still uses are kept (utils/sceneStorage.ts).
    const scenePrefixes = (sceneItems ?? []).flatMap(scene => sceneStoragePrefixes(id, scene as any))
    const shared = await filesStillUsed(
      fastify.supabase as any, scenePrefixes,
      ownMedia.filter(m => m.storage_key).map(m => m.storage_key as string), ownMedia.map(m => m.id), fastify.log,
    )
    if (bucketName && ownMedia.length > 0) {
      const keys = ownMedia.filter(m => m.storage_key && !shared.has(m.storage_key)).map(m => ({ Key: m.storage_key as string }))
      if (keys.length > 0) {
        try {
          await fastify.s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: keys } }))
        } catch (err: any) {
          fastify.log.error({ error: err?.message }, 'R2 batch delete failed for media during space deletion')
        }
      }
    }

    // 3b. Cleanup R2 — scene tile directories (thumbnail + all tile files), all scenes in parallel
    if (bucketName && sceneItems && sceneItems.length > 0) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
      // A scene moved in from another tour keeps its files in that tour's folder.
      await Promise.all(sceneItems.flatMap((scene) => sceneStoragePrefixes(id, scene as any).map(async (prefix) => {
        if (shared.has(prefix)) return
        try {
          const listed = await fastify.s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }))
          const objects = (listed.Contents ?? []).filter(o => o.Key).map(o => ({ Key: o.Key as string }))
          if (objects.length > 0) {
            await fastify.s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }))
          }
        } catch (err) {
          fastify.log.error(err, `Failed to delete scene tiles for scene ${scene.id}`)
        }
      })))
    }

    // 4. Update Quotas (tour count is recounted by a DB trigger; storage still via RPC)
    if (ownMedia.length > 0) {
      const totalSize = ownMedia.reduce((acc, item) => acc + Number(item.file_size_bytes || 0), 0)
      if (totalSize > 0) {
        await fastify.supabase.rpc('decrement_storage_usage', { u_id: userId, bytes: totalSize })
      }
    }

    // Bust billing cache so frontend sees the updated usage count immediately
    if (fastify.redis) {
      await fastify.redis.del(`billing:status:${userId}`).catch(() => {})
    }

    return reply.code(204).send()
  })

  // LOGO upload — returns a presigned PUT URL; client PUTs the file, then PATCHes /spaces/:id with logo_url
  fastify.post('/:id/logo-url', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const logoUploadBodySchema = z.object({
      fileName: z.string().trim().min(1).max(255),
      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']),
    })
    const body = parseWithSchema(reply, logoUploadBodySchema, request.body)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const bucketName = process.env.R2_BUCKET_NAME
    if (!bucketName) return reply.code(500).send({ statusMessage: 'Storage configuration error' })

    const rawExt = (body.fileName.split('.').pop() ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
    const fileExt = rawExt || 'jpg'
    const objectKey = `spaces/${id}/logo/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: body.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })

    try {
      const uploadUrl = await getSignedUrl(fastify.s3, command, { expiresIn: 900 })
      const customDomain = process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`
      const publicUrl = `${customDomain}/${objectKey}`
      return reply.send({ uploadUrl, publicUrl })
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ statusMessage: 'Failed to generate upload URL' })
    }
  })

  // UPDATE viewer settings (property_360_settings)
  fastify.patch('/:id/settings', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, updateSettingsBodySchema, request.body)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { data: settings, error } = await fastify.supabase
      .from('property_360_settings')
      .upsert({ property_id: params.id, ...body }, { onConflict: 'property_id' })
      .select()
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update viewer settings' })
    }
    return reply.send({ settings })
  })

  // IS A LINK FREE? — the Details tab checks the tour link (slug) as it's typed.
  // Same rules as the slug field of PATCH /:id. The tour's own current slug counts as free.
  fastify.get('/:id/slug-available', {
    preHandler: fastify.authenticate,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const userId = (request.user as any).sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const parsed = slugSchema.safeParse((request.query as any)?.slug)
    if (!parsed.success) {
      return reply.send({ available: false, reason: 'Use at least 3 characters: lowercase letters, numbers and hyphens.' })
    }
    const { data: owned } = await fastify.supabase
      .from('properties').select('id').eq('id', params.id).eq('user_id', userId).maybeSingle()
    if (!owned) return reply.code(404).send({ statusMessage: 'Tour not found' })
    const { data: holder } = await fastify.supabase
      .from('properties').select('id').eq('slug', parsed.data).maybeSingle()
    if (holder && holder.id !== params.id) return reply.send({ available: false, reason: 'Another tour already uses this link.' })
    return reply.send({ available: true })
  })

  // MOVE SCENES TO A NEW TOUR — e.g. two units shot in one session that belong
  // to different owners. One transaction in the database (move_scenes_to_new_tour):
  // the new tour copies the source's details and viewer settings, the chosen
  // scenes and photos move over with their hotspots, and arrows that would cross
  // between the two tours are removed. Files stay where they are in R2.
  fastify.post('/:id/move-scenes', {
    preHandler: fastify.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const userId = (request.user as any).sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, moveScenesBodySchema, request.body)
    if (!body) return

    const quotaCtx = await checkUserQuota(fastify, userId)
    if (quotaCtx.isGrace) {
      return reply.code(403).send({ statusMessage: 'Creating tours is disabled during the grace period. Please renew your subscription.' })
    }
    if (!quotaCtx.canWrite) {
      return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
    }
    const tourLimitReply = () => reply.code(403).send({
      statusMessage: quotaLimitMessage(quotaCtx.plan, 'tours'),
      code: 'TOUR_LIMIT_REACHED',
      limit: quotaCtx.plan.max_active_spaces,
      plan: quotaCtx.plan.name,
    })
    if (!(await canCreateSpace(fastify, userId, quotaCtx))) return tourLimitReply()

    const { data: source } = await fastify.supabase
      .from('properties')
      .select('id, slug')
      .eq('id', params.id)
      .eq('user_id', userId)
      .maybeSingle()
    if (!source) return reply.code(404).send({ statusMessage: 'Tour not found' })

    const base = generateSlug(body.title, randomUUID())
    let slug = body.publish ? await freeSlug(fastify, base) : null
    const run = () => fastify.supabase.rpc('move_scenes_to_new_tour', {
      p_user: userId,
      p_source: source.id,
      p_scene_ids: body.scene_ids,
      p_photo_ids: body.photo_ids,
      p_title: body.title,
      p_slug: slug,
    })
    let { data, error } = await run()
    // Someone took the slug between the lookup and the insert: one retry with a suffix.
    if (error?.code === '23505' && slug) {
      slug = `${base}-${randomUUID().slice(0, 6)}`
      ;({ data, error } = await run())
    }
    if (error) {
      if (isTourLimitError(error)) return tourLimitReply()
      if (error.code === 'PGRST202' || error.code === '42883') {
        fastify.log.error(error, 'move_scenes_to_new_tour missing — run migration-move-scenes.sql')
        return reply.code(503).send({ statusMessage: 'Moving scenes is not switched on yet. Please try again later.' })
      }
      const msg = error.message ?? ''
      if (msg.includes('MOVE_SCENE_NOT_IN_TOUR') || msg.includes('MOVE_PHOTO_NOT_IN_TOUR')) {
        return reply.code(409).send({ statusMessage: 'Some of these scenes or photos changed meanwhile. Reload and try again.' })
      }
      if (msg.includes('MOVE_NO_SCENES')) return reply.code(400).send({ statusMessage: 'Pick at least one scene to move.' })
      if (msg.includes('MOVE_SOURCE_NOT_FOUND')) return reply.code(404).send({ statusMessage: 'Tour not found' })
      fastify.log.error({ dbMessage: error.message, code: error.code, details: error.details, hint: error.hint }, 'move_scenes_to_new_tour failed')
      return reply.code(500).send({ statusMessage: 'Could not move the scenes. Nothing was changed.' })
    }

    const result = data as { id: string; slug: string | null; scenes: number; photos: number; panoramas: number; links_removed: number }
    request.log.info({ userId, source: source.id, ...result }, 'Moved scenes to a new tour')

    // Both public tours changed; the tile proxy's scene→space lookups are stale for moved scenes.
    await Promise.all([
      invalidateTourCache(fastify, source.id, source.slug),
      invalidateTourCache(fastify, result.id, result.slug),
      ...body.scene_ids.map(id => purgeSceneTiles(fastify, id)),
      fastify.redis ? fastify.redis.del(`billing:status:${userId}`).catch(() => {}) : Promise.resolve(),
    ])

    return reply.code(201).send({
      space: { id: result.id, slug: result.slug, title: body.title, is_published: !!result.slug },
      moved: { scenes: result.scenes, photos: result.photos },
      links_removed: result.links_removed,
    })
  })

  // ADD SCENES TO ANOTHER EXISTING TOUR — copy (they stay here too, e.g. the
  // entrance, lift and stairs two units share) or move. One transaction in the
  // database (add_scenes_to_tour). Files are never copied; copies point at the same
  // R2 files and the delete routes keep files a copy still uses.
  fastify.post('/:id/add-scenes-to-tour', {
    preHandler: fastify.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const userId = (request.user as any).sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, addScenesBodySchema, request.body)
    if (!body) return
    if (body.target_id === params.id) return reply.code(400).send({ statusMessage: 'Pick a different tour.' })

    const quotaCtx = await checkUserQuota(fastify, userId)
    if (quotaCtx.isGrace || !quotaCtx.canWrite) {
      return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
    }

    const { data: tours } = await fastify.supabase
      .from('properties')
      .select('id, slug, title')
      .in('id', [params.id, body.target_id])
      .eq('user_id', userId)
    const source = (tours ?? []).find((t: any) => t.id === params.id)
    const target = (tours ?? []).find((t: any) => t.id === body.target_id)
    if (!source) return reply.code(404).send({ statusMessage: 'Tour not found' })
    if (!target) return reply.code(404).send({ statusMessage: 'The other tour was not found in your account.' })

    // Scenes-per-tour limit applies to the tour receiving them.
    const max = quotaCtx.plan.max_scenes_per_tour
    if (max !== null && max !== undefined) {
      const { count } = await fastify.supabase
        .from('scenes').select('id', { count: 'exact', head: true }).eq('space_id', target.id)
      if ((count ?? 0) + new Set(body.scene_ids).size > max) {
        return reply.code(403).send({
          statusMessage: `${quotaLimitMessage(quotaCtx.plan, 'scenes')} “${target.title}” has ${count ?? 0} scenes.`,
          code: 'SCENE_LIMIT_REACHED',
          limit: max,
        })
      }
    }

    const { data, error } = await fastify.supabase.rpc('add_scenes_to_tour', {
      p_user: userId,
      p_source: source.id,
      p_target: target.id,
      p_scene_ids: body.scene_ids,
      p_photo_ids: body.photo_ids,
      p_copy: body.copy,
    })
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        fastify.log.error(error, 'add_scenes_to_tour missing — run migration-add-scenes-to-tour.sql')
        return reply.code(503).send({ statusMessage: 'Adding scenes to another tour is not switched on yet. Please try again later.' })
      }
      const msg = error.message ?? ''
      if (msg.includes('MOVE_SCENE_NOT_IN_TOUR') || msg.includes('MOVE_PHOTO_NOT_IN_TOUR')) {
        return reply.code(409).send({ statusMessage: 'Some of these scenes or photos changed meanwhile. Reload and try again.' })
      }
      if (msg.includes('MOVE_NO_SCENES')) return reply.code(400).send({ statusMessage: 'Pick at least one scene.' })
      if (msg.includes('ADD_SAME_TOUR')) return reply.code(400).send({ statusMessage: 'Pick a different tour.' })
      if (msg.includes('MOVE_SOURCE_NOT_FOUND') || msg.includes('ADD_TARGET_NOT_FOUND')) {
        return reply.code(404).send({ statusMessage: 'Tour not found' })
      }
      fastify.log.error({ dbMessage: error.message, code: error.code, details: error.details, hint: error.hint }, 'add_scenes_to_tour failed')
      return reply.code(500).send({ statusMessage: 'Could not add the scenes. Nothing was changed.' })
    }

    const result = data as { scenes: number; photos: number; hotspots: number; links_removed: number; copied: boolean; scene_ids?: string[] }
    request.log.info({ userId, source: source.id, target: target.id, copied: result.copied, scenes: result.scenes, photos: result.photos }, 'Added scenes to another tour')

    await Promise.all([
      invalidateTourCache(fastify, source.id, source.slug),
      invalidateTourCache(fastify, target.id, target.slug),
      ...(body.copy ? [] : body.scene_ids.map(id => purgeSceneTiles(fastify, id))),
      fastify.redis ? fastify.redis.del(`billing:status:${userId}`).catch(() => {}) : Promise.resolve(),
    ])

    return reply.send({
      space: { id: target.id, slug: target.slug, title: target.title },
      copied: result.copied,
      added: { scenes: result.scenes, photos: result.photos },
      // Ids in the other tour, in order: the editor opens the first one. Empty before
      // the migration that returns them has run.
      scene_ids: result.scene_ids ?? [],
      links_removed: result.links_removed,
    })
  })

  // PUBLISH space
  fastify.post('/:id/publish', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params
    const body = parseWithSchema(reply, publishBodySchema, request.body)
    if (!body) return

    const isPublishing = body.publish === true

    // 1. Ownership & Current State
    const { data: currentSpace, error: fetchErr } = await fastify.supabase
      .from('properties')
      .select('*, property_media(id, media_type, processing_status)')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (fetchErr || !currentSpace) {
      return reply.code(404).send({ statusMessage: 'Space not found' })
    }

    if (isPublishing) {
      // 2. Subscription Status Check
      const { plan, canWrite, isGrace } = await checkUserQuota(fastify, userId)

      if (isGrace) {
        return reply.code(403).send({ statusMessage: 'Publishing new spaces is disabled during the grace period. Please renew your subscription.' })
      }
      if (!canWrite) {
        return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
      }

      // 3. Entitlement Checks
      if (body.lead_form_enabled && !plan.lead_capture_enabled) {
        return reply.code(403).send({ statusMessage: 'Lead capture is not available on your current plan.' })
      }
      if (body.branding_enabled && !plan.branding_customization_enabled) {
        return reply.code(403).send({ statusMessage: 'Branding customization is not available on your current plan.' })
      }

      // 4. Media Requirement Check — a processed 360 scene OR a processed
      // gallery photo satisfies this; photos-only listings (PhotosPanel.vue,
      // used when the owner has no 360 camera) are a real, supported case,
      // not a fallback.
      const hasPanorama = currentSpace.property_media?.some(
        (item: any) => item.media_type === 'panorama' && item.processing_status === 'complete'
      )
      const hasGalleryPhoto = currentSpace.property_media?.some(
        (item: any) => item.media_type === 'gallery_image' && item.processing_status === 'complete'
      )
      // Aerial plot-map photos (uploaded as 'floor_plan' media) count too —
      // a land listing can be just drone photos with plots drawn on them.
      let hasAerialPhoto = currentSpace.property_media?.some(
        (item: any) => item.media_type === 'floor_plan' && item.processing_status !== 'failed'
      )
      if (!hasAerialPhoto) {
        const { count } = await fastify.supabase
          .from('aerial_maps').select('id', { count: 'exact', head: true }).eq('space_id', currentSpace.id)
        hasAerialPhoto = (count ?? 0) > 0 // errors (table not created yet) → count null → false
      }
      // A car can be just its exterior photos (vehicle_views). Errors (table not created yet) → false.
      let hasVehicleViews = false
      if (!hasPanorama && !hasGalleryPhoto && !hasAerialPhoto) {
        const { count } = await fastify.supabase
          .from('vehicle_views').select('id', { count: 'exact', head: true }).eq('space_id', currentSpace.id)
        hasVehicleViews = (count ?? 0) > 0
      }
      if (!hasPanorama && !hasGalleryPhoto && !hasAerialPhoto && !hasVehicleViews) {
        return reply.code(400).send({ statusMessage: 'Add a 360° scene, a photo, an exterior car photo or an aerial plot map before publishing.' })
      }
    }
    
    const updates: any = { is_published: isPublishing, visibility: isPublishing ? 'public' : 'private' }
    if (isPublishing) {
      if (!currentSpace.published_at) updates.published_at = new Date().toISOString()
      if (body.slug) updates.slug = body.slug

      // 5. Slug — auto-generate from title if not provided, falling back to id fragment
      if (!body.slug && !currentSpace.slug) {
        updates.slug = generateSlug(currentSpace.title, currentSpace.id)
      }
    } else {
      updates.published_at = null
    }

    const { data: space, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, title, slug, description, property_type, location_text, location_lat, location_lng, logo_url, phone, email, cover_image_url, has_360, has_gallery, is_published, published_at, visibility, lead_form_enabled, branding_enabled, created_at, updated_at')
      .single()

    if (error) {
      if (error.code === '23505') {
        return reply.code(400).send({ statusMessage: 'This URL slug is already in use. Please choose another one.' })
      }
      return reply.code(500).send({ statusMessage: 'Failed to update publish status' })
    }

    // Fire-and-forget: notify owner when tour first goes live
    if (isPublishing && !currentSpace.is_published) {
      const ownerEmail = (request.user as any)?.email as string | undefined
      const slug = space.slug || currentSpace.slug
      if (ownerEmail && slug) {
        void sendTourPublishedEmail({
          ownerEmail,
          spaceName: space.title,
          spaceSlug: slug,
        }).catch(err => fastify.log.error(err, 'Tour published email failed'))
      }
    }

    // Invalidate public cache
    await invalidateSpaceCache(fastify, id)

    return reply.send(space)
  })

  // GENERATE DESCRIPTION — AI-drafted listing description from whatever
  // facts are currently in the editor draft (price, bed/bath/m² or vehicle
  // specs, amenities). Returns the draft text only; the owner reviews/edits
  // it and saves via the normal PATCH /:id like any other field — this
  // never writes silently.
  fastify.post('/:id/generate-description', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params
    const body = parseWithSchema(reply, generateDescriptionBodySchema, request.body)
    if (!body) return

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return reply.code(503).send({
        statusMessage: 'AI description generation requires GEMINI_API_KEY to be configured on the server.',
      })
    }

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    let refundAi: () => Promise<void>
    try {
      refundAi = await consumeAi(fastify, userId, 'prompts')
    } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }

    // Tour photos let the model describe what is actually there (finishes, light, layout)
    const { data: scenes } = await fastify.supabase
      .from('scenes')
      .select('name, thumbnail_url')
      .eq('space_id', id)
      .eq('status', 'ready')
      .not('thumbnail_url', 'is', null)
      .order('order_index', { ascending: true })
      .limit(8)

    // A car listed by its exterior photos has no 360° scenes: show the model those instead.
    let describedScenes = (scenes ?? []).map(s => ({ name: s.name, thumbnailUrl: s.thumbnail_url, flat: false }))
    if (!describedScenes.length && body.space_type === 'automotive') {
      const { data: carViews } = await fastify.supabase
        .from('vehicle_views').select('label, image_url').eq('space_id', id)
        .order('angle', { ascending: true }).limit(8)
      describedScenes = (carViews ?? []).map(v => ({ name: v.label, thumbnailUrl: v.image_url, flat: true }))
    }

    try {
      const description = await generateListingDescription({
        title: body.title ?? null,
        property_type: body.space_type ?? null,
        location_text: body.location_text ?? null,
        price_kes: body.price_kes ?? null,
        bedrooms: body.bedrooms ?? null,
        bathrooms: body.bathrooms ?? null,
        area_sqm: body.area_sqm ?? null,
        vehicle_year: body.vehicle_year ?? null,
        vehicle_mileage_km: body.vehicle_mileage_km ?? null,
        vehicle_transmission: body.vehicle_transmission ?? null,
        vehicle_fuel_type: body.vehicle_fuel_type ?? null,
        land_acres: body.land_acres ?? null,
        land_type: body.land_type ?? null,
        amenities: body.amenities ?? null,
        listing_status: body.listing_status ?? null,
        transaction_type: body.transaction_type ?? null,
        price_period: body.price_period ?? null,
      }, apiKey, describedScenes)
      return reply.send({ description })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, spaceId: id }, '[generate-description] failed')
      await refundAi().catch(() => {})
      return reply.code(503).send({ reason: failureReason(err), statusMessage: 'Could not generate a description right now — try again shortly.' })
    }
  })
}
