import { FastifyInstance } from 'fastify'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { canCreateSpace, checkUserQuota } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'

const uuidSchema = z.string().uuid()

const slugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(200),
})

const idParamsSchema = z.object({
  id: uuidSchema,
})

const createSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']),
  description: z.string().max(2000).optional(),
  location_text: z.string().max(200).optional(),
  slug: z.string().trim().min(3).max(120).optional(),
})

const updateSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  cover_image_url: z.string().url().max(2048).nullable().optional(),
  location_text: z.string().max(200).nullable().optional(),
  slug: z.string().trim().min(3).max(120).nullable().optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']).optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
})

const publishBodySchema = z.object({
  publish: z.boolean(),
  slug: z.string().trim().min(3).max(120).optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
})

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Get space by slug or ID
  fastify.get('/by-slug/:slug', async (request, reply) => {
    const params = parseWithSchema(reply, slugParamsSchema, request.params)
    if (!params) return
    const { slug } = params
    
    // Check if slug is a valid UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)

    let query = fastify.supabase
      .from('properties')
      .select('*, property_media(*), property_360_settings(*), profiles(agency_name, agency_logo_url)')
      .eq('is_published', true)

    if (isUuid) {
      query = query.or(`id.eq.${slug},slug.eq.${slug}`)
    } else {
      query = query.eq('slug', slug)
    }

    const { data: space, error } = await query.single()

    if (error || !space) {
      return reply.code(404).send({ statusMessage: 'Space not found or unpublished' })
    }

    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300')
    return reply.send(space)
  })

  // All other space routes require authentication
  fastify.addHook('preHandler', fastify.authenticate)

  // GET all user spaces
  fastify.get('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data, error } = await fastify.supabase
      .from('properties')
      .select('id, title, slug, description, property_type, location_text, cover_image_url, has_360, has_gallery, is_published, visibility, lead_form_enabled, branding_enabled, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    const mappedData = (data || []).map(d => ({
      ...d,
      space_type: d.property_type,
      property_type: undefined
    }))

    return reply.send(mappedData)
  })

  // GET specific space
  fastify.get('/:id', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data, error } = await fastify.supabase
      .from('properties')
      .select(`
        id, title, slug, description, property_type, location_text,
        cover_image_url, has_360, has_gallery, is_published, published_at,
        visibility, lead_form_enabled, branding_enabled, created_at, updated_at,
        property_media (id, media_type, storage_key, public_url, width, height, file_size_bytes, sort_order, is_primary, created_at),
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
  fastify.post('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = parseWithSchema(reply, createSpaceBodySchema, request.body)
    if (!body) return

    // 1. Quota check
    const allowed = await canCreateSpace(fastify, userId)
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
        property_type: body.space_type
      })
      .select()
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to create space' })
    }

    const mappedSpace = {
      ...space,
      space_type: space.property_type,
      property_type: undefined
    }

    // 3. Update usage counter (RPC defined in migration 013)
    await fastify.supabase.rpc('increment_active_properties', { u_id: userId })

    return reply.code(201).send(mappedSpace)
  })

  // UPDATE space
  fastify.patch('/:id', async (request, reply) => {
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
    
    if (body.space_type !== undefined) updates.property_type = body.space_type

    if (body.lead_form_enabled !== undefined) updates.lead_form_enabled = body.lead_form_enabled
    if (body.branding_enabled !== undefined) updates.branding_enabled = body.branding_enabled
    if (body.slug !== undefined) updates.slug = body.slug

    const { data: space, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to update space' })
    }

    const mappedSpace = {
      ...space,
      space_type: space.property_type,
      property_type: undefined
    }

    return reply.send(mappedSpace)
  })

  // DELETE space
  fastify.delete('/:id', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    // 1. Get all media for this space before deleting
    const { data: mediaItems, error: mediaFetchErr } = await fastify.supabase
      .from('property_media')
      .select('id, storage_key, file_size_bytes, properties!inner(user_id)')
      .eq('property_id', id)
      .eq('properties.user_id', userId)

    // 2. Cleanup R2
    const bucketName = process.env.R2_BUCKET_NAME
    if (bucketName && mediaItems && mediaItems.length > 0) {
      for (const item of mediaItems) {
        if (item.storage_key) {
          try {
            await fastify.s3.send(new DeleteObjectCommand({
              Bucket: bucketName,
              Key: item.storage_key
            }))
          } catch (err) {
            fastify.log.error(err, `Failed to delete R2 object ${item.storage_key} during space deletion`)
          }
        }
      }
    }

    // 3. Delete property (DB handles cascading to property_media if configured, 
    // but we'll be explicit or rely on Supabase)
    const { error } = await fastify.supabase
      .from('properties')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to delete space' })
    }

    // 4. Update Quotas
    // Decrement active properties count
    await fastify.supabase.rpc('decrement_active_properties', { u_id: userId })

    // Decrement total storage used
    if (mediaItems && mediaItems.length > 0) {
      const totalSize = mediaItems.reduce((acc, item) => acc + Number(item.file_size_bytes || 0), 0)
      if (totalSize > 0) {
        const { data: counter } = await fastify.supabase
          .from('usage_counters')
          .select('storage_used_bytes')
          .eq('user_id', userId)
          .single()

        if (counter) {
          const newUsage = Math.max(0, Number(counter.storage_used_bytes) - totalSize)
          await fastify.supabase
            .from('usage_counters')
            .update({ storage_used_bytes: newUsage })
            .eq('user_id', userId)
        }
      }
    }

    return reply.code(204).send()
  })

  // PUBLISH space
  fastify.post('/:id/publish', async (request, reply) => {
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
      .select('*, property_media(id)')
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

      // 4. Media Requirement Check
      const mediaCount = currentSpace.property_media?.length || 0
      if (mediaCount === 0) {
        return reply.code(400).send({ statusMessage: 'Space must have at least one media item (Panorama or Gallery) to be published.' })
      }

      // 5. Slug Check
      if (!body.slug && !currentSpace.slug) {
        return reply.code(400).send({ statusMessage: 'A unique slug is required to publish.' })
      }
    }

    const updates: any = { is_published: isPublishing }
    if (isPublishing) {
      updates.published_at = new Date().toISOString()
      if (body.slug) updates.slug = body.slug
    } else {
      updates.published_at = null
    }

    const { data: space, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return reply.code(400).send({ statusMessage: 'This URL slug is already in use. Please choose another one.' })
      }
      return reply.code(500).send({ statusMessage: 'Failed to update publish status' })
    }

    return reply.send(space)
  })
}
