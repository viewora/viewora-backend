import { FastifyInstance } from 'fastify'
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { canCreateSpace, checkUserQuota } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'
import { sendTourPublishedEmail } from '../email/index.js'
import { invalidateSpaceCache } from '../utils/cache.js'
import { generateSpaceFloorPlan } from '../utils/floor-plan-generator.js'
import { generateListingDescription } from '../utils/aiDescription.js'

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
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']),
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
  floorplan_url: z.string().url().max(2048).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  slug: slugSchema.nullable().optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']).optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
  cta_enabled: z.boolean().optional(),
  cta_button_text: z.string().max(80).nullable().optional(),
  cta_action: z.enum(['link', 'email', 'phone']).nullable().optional(),
  cta_destination: z.string().max(2048).nullable().optional(),
  ...listingFactsSchema,
})

// Deliberately takes the CURRENT (possibly unsaved) editor draft as the
// request body rather than re-reading the DB — the owner may have just
// typed a new price/bed count and not hit Save Settings yet, and the
// description should reflect what's on screen, not stale saved values.
const generateDescriptionBodySchema = z.object({
  title: z.string().max(120).optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']).optional(),
  location_text: z.string().max(200).optional(),
  ...listingFactsSchema,
})

const updateSettingsBodySchema = z.object({
  hfov_default: z.number().min(30).max(120).optional(),
  yaw_default: z.number().min(-180).max(180).optional(),
  pitch_default: z.number().min(-90).max(90).optional(),
  auto_rotate_enabled: z.boolean().optional(),
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
      .select('id, title, slug, description, property_type, location_text, location_lat, location_lng, logo_url, floorplan_url, phone, email, cover_image_url, has_360, has_gallery, is_published, visibility, lead_form_enabled, branding_enabled, price_kes, listing_status, transaction_type, price_period, bedrooms, bathrooms, area_sqm, vehicle_year, vehicle_mileage_km, vehicle_transmission, vehicle_fuel_type, land_acres, land_type, amenities, view_count, claim_state, created_via, created_at, updated_at, scenes ( thumbnail_url, order_index ), property_media ( public_url, media_type, sort_order, is_primary, processing_status )', { count: 'exact' })
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
        logo_url, floorplan_url, phone, email, cover_image_url, has_360, has_gallery, is_published, published_at,
        visibility, lead_form_enabled, branding_enabled,
        cta_enabled, cta_button_text, cta_action, cta_destination,
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
    const allowed = await canCreateSpace(fastify, userId, quotaCtx)
    if (!allowed) {
      return reply.code(403).send({ statusMessage: 'Space creation limit reached for your current plan.' })
    }

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
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to create space' })
    }

    const mappedSpace = {
      ...space,
      space_type: space.property_type,
      property_type: undefined
    }

    // 3. Update usage counter (RPC defined in migration 013)
    const { error: incrErr } = await fastify.supabase.rpc('increment_active_properties', { u_id: userId })
    if (incrErr) fastify.log.error(incrErr, 'Failed to increment active_properties counter')

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
    if (body.floorplan_url !== undefined) updates.floorplan_url = body.floorplan_url
    if (body.phone !== undefined) updates.phone = body.phone
    if (body.email !== undefined) updates.email = body.email
    if (body.cta_enabled !== undefined) updates.cta_enabled = body.cta_enabled
    if (body.cta_button_text !== undefined) updates.cta_button_text = body.cta_button_text
    if (body.cta_action !== undefined) updates.cta_action = body.cta_action
    if (body.cta_destination !== undefined) updates.cta_destination = body.cta_destination
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

    const { data: space, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') return reply.code(404).send({ statusMessage: 'Space not found' })
      return reply.code(500).send({ statusMessage: 'Failed to update space' })
    }

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
        .select('id, storage_key, file_size_bytes, properties!inner(user_id)')
        .eq('property_id', id)
        .eq('properties.user_id', userId),
      fastify.supabase
        .from('scenes')
        .select('id, space_id')
        .eq('space_id', id),
    ])

    if (mediaFetchErr) {
      return reply.code(500).send({ statusMessage: 'Failed to load space media' })
    }

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
    if (bucketName && mediaItems && mediaItems.length > 0) {
      const keys = mediaItems.filter(m => m.storage_key).map(m => ({ Key: m.storage_key as string }))
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
      await Promise.all(sceneItems.map(async (scene) => {
        const prefix = `spaces/${id}/scenes/${scene.id}/`
        try {
          const listed = await fastify.s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }))
          const objects = (listed.Contents ?? []).filter(o => o.Key).map(o => ({ Key: o.Key as string }))
          if (objects.length > 0) {
            await fastify.s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }))
          }
        } catch (err) {
          fastify.log.error(err, `Failed to delete scene tiles for scene ${scene.id}`)
        }
      }))
    }

    // 4. Update Quotas
    const { error: decrErr } = await fastify.supabase.rpc('decrement_active_properties', { u_id: userId })
    if (decrErr) fastify.log.error(decrErr, 'Failed to decrement active_properties counter')

    if (mediaItems && mediaItems.length > 0) {
      const totalSize = mediaItems.reduce((acc, item) => acc + Number(item.file_size_bytes || 0), 0)
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

  // FLOOR PLAN upload — returns a presigned PUT URL; client PUTs the file, then PATCHes /spaces/:id with floorplan_url
  fastify.post('/:id/floorplan-url', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const floorplanUploadBodySchema = z.object({
      fileName: z.string().trim().min(1).max(255),
      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']),
    })
    const body = parseWithSchema(reply, floorplanUploadBodySchema, request.body)
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
    const objectKey = `spaces/${id}/floorplan/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`

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
      if (!hasPanorama && !hasGalleryPhoto) {
        return reply.code(400).send({ statusMessage: 'Add at least one processed 360° scene or photo before publishing.' })
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

  // REGENERATE FLOOR PLAN — manually triggers floor-plan generation for a space.
  // Use this for spaces that were tiled before the auto-generation feature shipped,
  // or any time you want to refresh the floor plan after editing hotspots.
  fastify.post('/:id/regenerate-floor-plan', { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    // Verify ownership
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const cdnBase = process.env.MEDIA_DOMAIN
      || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

    const floorplanUrl = await generateSpaceFloorPlan(
      fastify.s3,
      fastify.supabase,
      id,
      cdnBase,
      fastify.redis ?? null,
    )

    if (!floorplanUrl) {
      return reply.code(422).send({
        statusMessage: 'Floor plan could not be generated. Make sure the space has at least one scene with hotspots.',
      })
    }

    return reply.send({ floorplanUrl })
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

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return reply.code(503).send({
        statusMessage: 'AI description generation requires ANTHROPIC_API_KEY to be configured on the server.',
      })
    }

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

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
        amenities: body.amenities ?? null,
        listing_status: body.listing_status ?? null,
        transaction_type: body.transaction_type ?? null,
        price_period: body.price_period ?? null,
      }, apiKey)
      return reply.send({ description })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, spaceId: id }, '[generate-description] failed')
      return reply.code(502).send({ statusMessage: 'Could not generate a description right now — try again shortly.' })
    }
  })
}
