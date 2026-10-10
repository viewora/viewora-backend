import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { LISTING_SELECT_FRAGMENT, mapListingRow } from '../utils/listingMapper.js'
import { mergeSceneGroups, publicAerialMaps } from './aerial.js'

const tourParamsSchema = z.object({
  slug: z.string().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Invalid slug'),
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const listingsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  type: z.enum(['all', 'residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other']).optional(),
  status: z.enum(['all', 'available', 'sold', 'rented']).optional(),
  transaction: z.enum(['all', 'sale', 'rent']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).optional(),
  q: z.string().max(200).optional(),
  price_min: z.string().regex(/^\d+$/).optional(),
  price_max: z.string().regex(/^\d+$/).optional(),
  beds_min: z.string().regex(/^\d+$/).optional(),
  baths_min: z.string().regex(/^\d+$/).optional(),
  area_min: z.string().regex(/^\d+$/).optional(),
  // Comma-separated UUIDs — powers the shareable "Collection" view
  // (/view/collection?ids=...), an explicit, sender-picked set of listings
  // rather than a saved filter. Bypasses the type/status/search filters and
  // the 'available'-only default below: someone sharing "here's what I
  // looked at" should still see a since-sold listing, not have it vanish.
  ids: z.string().max(2000).optional(),
})

export default async function publicRoutes(fastify: FastifyInstance) {

  // ── OWNER CHECK ──────────────────────────────────────────────
  // Lets the public buyer-facing detail screen (view/p/[slug].vue) show
  // inline owner-only editing without ever learning the owner's actual
  // user_id — the public /p/:slug response deliberately never includes it
  // (see migration-fix-public-tour-leak.sql). Auth required, so an
  // anonymous buyer never even calls this.
  fastify.get('/p/:slug/is-owner', { preHandler: fastify.authenticate }, async (req, reply) => {
    const params = parseWithSchema(reply, tourParamsSchema, (req as any).params)
    if (!params) return
    const user = req.user as any
    const userId = user.sub

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .or(`slug.eq.${params.slug},id.eq.${params.slug}`)
      .eq('user_id', userId)
      .maybeSingle()

    return reply.send({ isOwner: !!space })
  })

  // ── AUTHENTICATED TOUR PREVIEW ─────────────────────────────
  // Requires auth. Allows owners to preview their tour even if it's not published.
  fastify.get('/p/preview/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const params = parseWithSchema(reply, idParamsSchema, (req as any).params)
    if (!params) return
    const user = req.user as any
    const userId = user.sub

    // Verify ownership and get slug
    const { data: space, error: spaceError } = await fastify.supabase
      .from('properties')
      .select('slug')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single()

    if (spaceError || !space) {
      return reply.code(404).send({ statusMessage: 'Tour not found or access denied' })
    }

    // Direct query to fetch tour data bypassing the is_published check
    const { data: spaceData, error: spaceDataError } = await fastify.supabase
      .from('properties')
      .select(`
        *,
        property_360_settings (id, hfov_default, pitch_default, yaw_default, auto_rotate_enabled),
        scenes (
          id,
          name,
          order_index,
          raw_image_url,
          tile_manifest_url,
          tile_medium_manifest_url,
          tile_medium_cols,
          tile_medium_rows,
          tile_medium_ktx2_manifest_url,
          thumbnail_url,
          status,
          initial_yaw,
          initial_pitch,
          tile_cols,
          tile_rows,
          tiles_ready,
          width,
          height,
          position_x,
          position_y,
          hotspots (
            *
          )
        )
      `)
      .eq('id', params.id)
      .single()

    if (spaceDataError || !spaceData) {
      return reply.code(404).send({ statusMessage: 'Tour data unavailable' })
    }

    // Map to match the get_tour_data RPC output shape
    const formattedSpace = {
      ...spaceData,
      space_type: (spaceData as any).property_type,
      property_type: undefined
    }

    const formattedData = {
      space: formattedSpace,
      scenes: (spaceData as any).scenes.sort((a: any, b: any) => (a.order_index || 0) - (b.order_index || 0))
    }

    const aerial_maps = await publicAerialMaps(fastify, params.id)
    await mergeSceneGroups(fastify, params.id, formattedData.scenes)
    reply.header('X-Cache', 'BYPASS')
    return reply.send({ tour: { ...formattedData, aerial_maps } })
  })

  // ── SITEMAP DATA ──────────────────────────────────────────
  // Returns all published, public tour slugs + last-modified dates for sitemap generation.
  // Lightweight: only reads two columns, no RPC, no per-row auth check.
  fastify.get('/sitemap-data', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('properties')
      .select('slug, updated_at')
      .eq('is_published', true)
      .eq('visibility', 'public')
      .not('slug', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(50000)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch sitemap data' })
    }

    reply.header('Cache-Control', 'public, s-maxage=3600')
    return reply.send({
      slugs: (data ?? []).map((row: any) => ({
        slug: row.slug as string,
        updated_at: row.updated_at as string,
      })),
    })
  })

  // ── PUBLIC LISTINGS FEED ───────────────────────────────────
  // Backs the Home tab (VIEWORA_2_PRODUCT_SPEC.md §6) — the buyer-facing
  // discovery surface that didn't exist before this endpoint. No auth
  // required. price_kes IS NOT NULL is the "must have a price to appear"
  // rule from §3.1 — enforced here at the query level, not as a DB
  // constraint, so it applies uniformly regardless of how a listing was
  // created.
  fastify.get('/listings', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (request: any) => request.ip },
    },
  }, async (req, reply) => {
    const query = parseWithSchema(reply, listingsQuerySchema, (req as any).query)
    if (!query) return

    const limit = Math.min(Number(query.limit) || 20, 50)
    const page = Math.max(Number(query.page) || 1, 1)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const idList = query.ids
      ? query.ids.split(',').map((s) => s.trim()).filter((id) => uuidRe.test(id)).slice(0, 30)
      : null

    let builder = fastify.supabase
      .from('properties')
      .select(LISTING_SELECT_FRAGMENT, { count: 'exact' })
      .eq('is_published', true)
      .eq('visibility', 'public')
      .not('price_kes', 'is', null)

    if (idList) {
      // Collection view — an explicit, sender-picked set. No pagination, no
      // status/type/search filters: whatever's in the list is what shows.
      builder = builder.in('id', idList)
    } else {
      if (query.type && query.type !== 'all') builder = builder.eq('property_type', query.type)
      if (query.transaction && query.transaction !== 'all') builder = builder.eq('transaction_type', query.transaction)
      // Default to 'available' only — a buyer browsing the feed isn't looking
      // for sold/rented listings unless they explicitly ask to see everything.
      if (query.status && query.status !== 'all') builder = builder.eq('listing_status', query.status)
      else if (!query.status) builder = builder.eq('listing_status', 'available')
      // Search tab (§7) matches on location or title — a buyer typing
      // "Kilimani" or a car's make/model should both work.
      if (query.q) builder = builder.or(`location_text.ilike.%${query.q}%,title.ilike.%${query.q}%`)
      if (query.price_min) builder = builder.gte('price_kes', Number(query.price_min))
      if (query.price_max) builder = builder.lte('price_kes', Number(query.price_max))
      if (query.beds_min) builder = builder.gte('bedrooms', Number(query.beds_min))
      if (query.baths_min) builder = builder.gte('bathrooms', Number(query.baths_min))
      if (query.area_min) builder = builder.gte('area_sqm', Number(query.area_min))

      if (query.sort === 'price_asc') builder = builder.order('price_kes', { ascending: true })
      else if (query.sort === 'price_desc') builder = builder.order('price_kes', { ascending: false })
      else builder = builder.order('created_at', { ascending: false })

      builder = builder.range(from, to)
    }

    const { data, error, count } = await builder

    if (error) {
      fastify.log.error(error, 'Failed to fetch public listings')
      return reply.code(500).send({ statusMessage: 'Failed to fetch listings' })
    }

    const listings = (data || []).map(mapListingRow)

    reply.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return reply.send({ data: listings, total: count ?? listings.length, page, limit })
  })

  // ── PUBLIC TOUR VIEWER ────────────────────────────────────
  // No auth required. Calls the get_tour_data() RPC which checks
  // is_published=true AND visibility='public' before returning anything.
  fastify.get('/p/:slug', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (req, reply) => {
    const params = parseWithSchema(reply, tourParamsSchema, (req as any).params)
    if (!params) return
    fastify.log.info({ slug: params.slug }, 'Public tour request')
    const cacheKey = `tour:${params.slug}`

    let data: any
    let cacheStatus: 'HIT' | 'MISS'

    // Serve from Redis cache when available — skips the Supabase RPC entirely
    const cached = fastify.redis ? await fastify.redis.get(cacheKey).catch(() => null) : null
    if (cached) {
      data = JSON.parse(cached)
      cacheStatus = 'HIT'
      fastify.log.info({ slug: params.slug }, 'Public tour cache HIT')
    } else {
      const { data: rpcData, error } = await fastify.supabase
        .rpc('get_tour_data', { p_slug: params.slug })

      if (error) {
        fastify.log.error({ error, slug: params.slug }, 'Public tour RPC error')
        throw error
      }

      if (!rpcData) {
        fastify.log.warn({ slug: params.slug }, 'Public tour not found in DB')
        return reply.code(404).send({ statusMessage: 'Tour not found' })
      }

      fastify.log.info({ slug: params.slug }, 'Public tour DB HIT')
      data = rpcData

      // Map property_type to space_type for consistency with the frontend
      if (data.space) {
        data.space.space_type = data.space.property_type
        delete data.space.property_type
      }

      cacheStatus = 'MISS'

      // Cache tour data for 1h — safe because invalidateSpaceCache() is called on every
      // publish, unpublish, scene update, hotspot change, and tile completion.
      if (fastify.redis) {
        void fastify.redis.setEx(cacheKey, 3600, JSON.stringify(data)).catch(() => {})
      }
    }

    // Gallery photos are fetched fresh on every request rather than folded
    // into the cached RPC blob above — uploads.ts has no cache-invalidation
    // hook, so caching this would mean a newly processed gallery photo
    // could take up to an hour to appear.
    if (data.space?.id) {
      const { data: galleryRows } = await fastify.supabase
        .from('property_media')
        .select('id, public_url, is_primary, sort_order')
        .eq('property_id', data.space.id)
        .eq('media_type', 'gallery_image')
        .eq('processing_status', 'complete')
        .order('is_primary', { ascending: false })
        .order('sort_order', { ascending: true })

      data.gallery = (galleryRows || []).map((r: any) => ({ id: r.id, url: r.public_url, is_primary: r.is_primary }))

      // Same "fetch fresh, don't bake into the cached RPC blob" reasoning as
      // gallery above — a seller editing their profile shouldn't wait for
      // the tour cache to expire to see it reflected. get_tour_data()'s
      // 'space' object deliberately never includes user_id (see
      // migration-fix-public-tour-leak.sql) so it's looked up here instead,
      // never handed to the client directly — only these public-safe
      // profile fields are. No "Verified" or license fields: Viewora has no
      // verification/brokerage-licensing system to back them honestly.
      const { data: ownerRow } = await fastify.supabase
        .from('properties')
        .select('profiles:profiles!properties_user_id_fkey ( id, full_name, avatar_url, bio, company_name )')
        .eq('id', data.space.id)
        .maybeSingle()
      data.seller = (ownerRow as any)?.profiles ?? null
      // Aerial plot maps — fetched fresh like gallery (own table, not in the cached RPC blob).
      data.aerial_maps = await publicAerialMaps(fastify, data.space.id)
      // Scene categories — merged fresh like gallery/aerial (not in the cached RPC blob).
      await mergeSceneGroups(fastify, data.space.id, data.scenes)
    } else {
      data.gallery = []
      data.seller = null
      data.aerial_maps = []
    }

    reply.header('X-Cache', cacheStatus)
    return reply.send({ tour: data })
  })
}
