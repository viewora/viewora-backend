import { FastifyInstance } from 'fastify'
import { DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { canCreateSpace, checkUserQuota } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'
import { sendTourPublishedEmail } from '../email/index.js'

const uuidSchema = z.string().uuid()

const idParamsSchema = z.object({
  id: uuidSchema,
})

const slugSchema = z.string().trim().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens')

const createSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']),
  description: z.string().max(2000).optional(),
  location_text: z.string().max(200).optional(),
  slug: slugSchema.optional(),
})

const updateSpaceBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  cover_image_url: z.string().url().max(2048).nullable().optional(),
  location_text: z.string().max(200).nullable().optional(),
  slug: slugSchema.nullable().optional(),
  space_type: z.enum(['residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']).optional(),
  lead_form_enabled: z.boolean().optional(),
  branding_enabled: z.boolean().optional(),
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
      .select('id, title, slug, description, property_type, location_text, cover_image_url, has_360, has_gallery, is_published, visibility, lead_form_enabled, branding_enabled, created_at, updated_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch spaces' })
    }

    const mappedData = (data || []).map(d => ({
      ...d,
      space_type: d.property_type,
      property_type: undefined
    }))

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
        id, title, slug, description, property_type, location_text,
        cover_image_url, has_360, has_gallery, is_published, published_at,
        visibility, lead_form_enabled, branding_enabled, created_at, updated_at,
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
        property_type: body.space_type
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
    await fastify.supabase.rpc('increment_active_properties', { u_id: userId })

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

    // 3b. Cleanup R2 — scene tile directories (thumbnail + all tile files)
    if (bucketName && sceneItems && sceneItems.length > 0) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
      for (const scene of sceneItems) {
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
      }
    }

    // 4. Update Quotas
    await fastify.supabase.rpc('decrement_active_properties', { u_id: userId })

    if (mediaItems && mediaItems.length > 0) {
      const totalSize = mediaItems.reduce((acc, item) => acc + Number(item.file_size_bytes || 0), 0)
      if (totalSize > 0) {
        await fastify.supabase.rpc('decrement_storage_usage', { u_id: userId, bytes: totalSize })
      }
    }

    return reply.code(204).send()
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

    if (error) throw error
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

      // 4. Media Requirement Check
      const hasPanorama = currentSpace.property_media?.some(
        (item: any) => item.media_type === 'panorama' && item.processing_status === 'complete'
      )
      if (!hasPanorama) {
        return reply.code(400).send({ statusMessage: 'Space must have at least one processed panorama image to be published.' })
      }

      // 5. Slug Check
      if (!body.slug && !currentSpace.slug) {
        return reply.code(400).send({ statusMessage: 'A unique slug is required to publish.' })
      }
    }

    const updates: any = { is_published: isPublishing }
    if (isPublishing) {
      if (!currentSpace.published_at) updates.published_at = new Date().toISOString()
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

    return reply.send(space)
  })
}
