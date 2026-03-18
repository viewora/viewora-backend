import { FastifyInstance } from 'fastify'
import { canCreateProperty, checkUserQuota } from '../utils/quotas.js'

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Get property by slug
  fastify.get('/by-slug/:slug', async (request, reply) => {
    const { slug } = request.params as any
    
    const { data: property, error } = await fastify.supabase
      .from('properties')
      .select('*, property_media(*), property_360_settings(*)')
      .eq('slug', slug)
      .eq('is_published', true)
      .single()

    if (error || !property) {
      return reply.code(404).send({ statusMessage: 'Property not found or unpublished' })
    }

    return reply.send(property)
  })

  // All other property routes require authentication
  fastify.addHook('preHandler', fastify.authenticate)

  // CREATE property
  fastify.post('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = request.body as any

    // 1. Quota check
    const allowed = await canCreateProperty(fastify, userId)
    if (!allowed) {
      return reply.code(403).send({ statusMessage: 'Property creation limit reached for your current plan.' })
    }

    // 2. Create property
    const { data: property, error } = await fastify.supabase
      .from('properties')
      .insert({
        user_id: userId,
        title: body.title || 'New Property',
        description: body.description || null,
        slug: body.slug || null
      })
      .select()
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to create property' })
    }

    // 3. Update usage counter (RPC defined in migration 013)
    await fastify.supabase.rpc('increment_active_properties', { u_id: userId })

    return reply.code(201).send(property)
  })

  // UPDATE property
  fastify.patch('/:id', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any
    const body = request.body as any

    const updates: any = {}
    if (body.title !== undefined) updates.title = body.title
    if (body.description !== undefined) updates.description = body.description
    if (body.cover_image_url !== undefined) updates.cover_image_url = body.cover_image_url
    if (body.location_text !== undefined) updates.location_text = body.location_text
    if (body.property_type !== undefined) updates.property_type = body.property_type
    if (body.lead_form_enabled !== undefined) updates.lead_form_enabled = body.lead_form_enabled
    if (body.branding_enabled !== undefined) updates.branding_enabled = body.branding_enabled
    if (body.slug !== undefined) updates.slug = body.slug

    const { data: property, error } = await fastify.supabase
      .from('properties')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to update property' })
    }

    return reply.send(property)
  })

  // DELETE property
  fastify.delete('/:id', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any

    const { error } = await fastify.supabase
      .from('properties')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to delete property' })
    }

    // Decrement counter
    await fastify.supabase.rpc('decrement_active_properties', { u_id: userId })

    return reply.code(204).send()
  })

  // PUBLISH property
  fastify.post('/:id/publish', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any
    const body = request.body as any

    const isPublishing = body.publish === true

    // 1. Ownership & Current State
    const { data: currentProp, error: fetchErr } = await fastify.supabase
      .from('properties')
      .select('*, property_media(id)')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (fetchErr || !currentProp) {
      return reply.code(404).send({ statusMessage: 'Property not found' })
    }

    if (isPublishing) {
      // 2. Subscription Status Check
      const { plan, subscription } = await checkUserQuota(fastify, userId)
      const activeStatuses = ['active', 'trialing', 'trial']
      
      if (!subscription || !activeStatuses.includes(subscription.status)) {
        if (subscription?.status === 'grace_period') {
          return reply.code(403).send({ statusMessage: 'New publishing is disabled during grace period. Please renew your subscription.' })
        }
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
      const mediaCount = currentProp.property_media?.length || 0
      if (mediaCount === 0) {
        return reply.code(400).send({ statusMessage: 'Property must have at least one media item (Panorama or Gallery) to be published.' })
      }

      // 5. Slug Check
      if (!body.slug && !currentProp.slug) {
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

    const { data: property, error } = await fastify.supabase
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

    return reply.send(property)
  })
}
