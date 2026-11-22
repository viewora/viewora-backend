import { randomBytes } from 'crypto'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const uuid = z.string().uuid()
const collectionParams = z.object({ id: uuid })
const showcaseParams = z.object({ slug: z.string().trim().min(3).max(140).regex(/^[a-z0-9-]+$/) })
const orderedItems = z.array(uuid).min(1, 'Choose at least one tour').max(30, 'A showcase can contain up to 30 tours')

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  property_ids: orderedItems,
  is_published: z.boolean().optional(),
})

const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  property_ids: orderedItems.optional(),
  is_published: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')

function makeSlug(title: string) {
  const base = title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return `${base || 'showcase'}-${randomBytes(3).toString('hex')}`
}

async function assertOwnedTours(fastify: FastifyInstance, ownerId: string, propertyIds: string[]) {
  const uniqueIds = [...new Set(propertyIds)]
  if (uniqueIds.length !== propertyIds.length) return { error: 'A tour can only appear once in a showcase' }

  const { data, error } = await fastify.supabase
    .from('properties')
    .select('id')
    .eq('user_id', ownerId)
    .in('id', uniqueIds)

  if (error) throw error
  if ((data || []).length !== uniqueIds.length) return { error: 'One or more selected tours could not be found' }
  return { error: null }
}

async function findOwnedCollection(fastify: FastifyInstance, id: string, ownerId: string) {
  return fastify.supabase
    .from('collections')
    .select('id, title, slug, description, cover_image, is_published, created_at, updated_at')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle()
}

export default async function collectionRoutes(fastify: FastifyInstance) {
  fastify.get('/collections', { preHandler: fastify.authenticate }, async (request, reply) => {
    const ownerId = (request.user as any).sub
    const { data, error } = await fastify.supabase
      .from('collections')
      .select('id, title, slug, description, cover_image, is_published, created_at, updated_at, collection_items(property_id, position)')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })

    if (error) {
      request.log.error(error, 'Failed to list showcases')
      return reply.code(500).send({ statusMessage: 'Could not load showcases' })
    }

    return reply.send({ showcases: (data || []).map((item: any) => ({
      ...item,
      tour_count: item.collection_items?.length || 0,
      collection_items: undefined,
    })) })
  })

  fastify.get('/collections/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, collectionParams, request.params)
    if (!params) return
    const ownerId = (request.user as any).sub
    const { data: showcase, error } = await findOwnedCollection(fastify, params.id, ownerId)
    if (error) return reply.code(500).send({ statusMessage: 'Could not load showcase' })
    if (!showcase) return reply.code(404).send({ statusMessage: 'Showcase not found' })

    const { data: items, error: itemsError } = await fastify.supabase
      .from('collection_items')
      .select('position, properties!inner(id, title, slug, cover_image_url, is_published, visibility, space_type:property_type)')
      .eq('collection_id', params.id)
      .order('position')
    if (itemsError) return reply.code(500).send({ statusMessage: 'Could not load showcase tours' })

    return reply.send({
      ...showcase,
      tours: (items || []).map((item: any) => ({ position: item.position, ...item.properties })).filter(Boolean),
    })
  })

  fastify.post('/collections', { preHandler: fastify.authenticate }, async (request, reply) => {
    const body = parseWithSchema(reply, createSchema, request.body)
    if (!body) return
    const ownerId = (request.user as any).sub
    try {
      const ownership = await assertOwnedTours(fastify, ownerId, body.property_ids)
      if (ownership.error) return reply.code(400).send({ statusMessage: ownership.error })

      const { data: firstTour } = await fastify.supabase
        .from('properties').select('cover_image_url').eq('id', body.property_ids[0]).maybeSingle()
      const { data: showcase, error } = await fastify.supabase
        .from('collections')
        .insert({ owner_id: ownerId, title: body.title, description: body.description ?? null, slug: makeSlug(body.title), cover_image: firstTour?.cover_image_url || null, is_published: body.is_published ?? false })
        .select('id, title, slug, description, cover_image, is_published, created_at, updated_at')
        .single()
      if (error || !showcase) {
        request.log.error(error, 'Failed to create showcase')
        return reply.code(500).send({ statusMessage: 'Could not create showcase' })
      }

      const { error: itemsError } = await fastify.supabase.from('collection_items').insert(
        body.property_ids.map((property_id, position) => ({ collection_id: showcase.id, property_id, position })),
      )
      if (itemsError) {
        await fastify.supabase.from('collections').delete().eq('id', showcase.id).eq('owner_id', ownerId)
        request.log.error(itemsError, 'Failed to add showcase tours')
        return reply.code(500).send({ statusMessage: 'Could not add tours to showcase' })
      }
      return reply.code(201).send({ ...showcase, tour_count: body.property_ids.length })
    } catch (error) {
      request.log.error(error, 'Failed to create showcase')
      return reply.code(500).send({ statusMessage: 'Could not create showcase' })
    }
  })

  fastify.patch('/collections/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, collectionParams, request.params)
    const body = parseWithSchema(reply, updateSchema, request.body)
    if (!params || !body) return
    const ownerId = (request.user as any).sub
    const { data: existing, error: existingError } = await findOwnedCollection(fastify, params.id, ownerId)
    if (existingError) return reply.code(500).send({ statusMessage: 'Could not update showcase' })
    if (!existing) return reply.code(404).send({ statusMessage: 'Showcase not found' })

    try {
      if (body.property_ids) {
        const ownership = await assertOwnedTours(fastify, ownerId, body.property_ids)
        if (ownership.error) return reply.code(400).send({ statusMessage: ownership.error })
        const { error: deleteError } = await fastify.supabase.from('collection_items').delete().eq('collection_id', params.id)
        if (deleteError) throw deleteError
        const { error: itemsError } = await fastify.supabase.from('collection_items').insert(
          body.property_ids.map((property_id, position) => ({ collection_id: params.id, property_id, position })),
        )
        if (itemsError) throw itemsError
      }

      const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (body.title !== undefined) update.title = body.title
      if (body.description !== undefined) update.description = body.description
      if (body.is_published !== undefined) update.is_published = body.is_published
      const { data, error } = await fastify.supabase
        .from('collections').update(update).eq('id', params.id).eq('owner_id', ownerId)
        .select('id, title, slug, description, cover_image, is_published, created_at, updated_at').single()
      if (error) throw error
      return reply.send({ ...data, tour_count: body.property_ids?.length })
    } catch (error) {
      request.log.error(error, 'Failed to update showcase')
      return reply.code(500).send({ statusMessage: 'Could not update showcase' })
    }
  })

  fastify.delete('/collections/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, collectionParams, request.params)
    if (!params) return
    const ownerId = (request.user as any).sub
    const { error, count } = await fastify.supabase.from('collections').delete({ count: 'exact' }).eq('id', params.id).eq('owner_id', ownerId)
    if (error) return reply.code(500).send({ statusMessage: 'Could not delete showcase' })
    if (!count) return reply.code(404).send({ statusMessage: 'Showcase not found' })
    return reply.code(204).send()
  })

  fastify.get('/showcases/:slug', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (request: any) => request.ip } },
  }, async (request, reply) => {
    const params = parseWithSchema(reply, showcaseParams, request.params)
    if (!params) return
    const { data: showcase, error } = await fastify.supabase
      .from('collections')
      .select('id, title, slug, description, cover_image, updated_at')
      .eq('slug', params.slug).eq('is_published', true).maybeSingle()
    if (error) return reply.code(500).send({ statusMessage: 'Could not load showcase' })
    if (!showcase) return reply.code(404).send({ statusMessage: 'Showcase not found' })

    const { data: items, error: itemsError } = await fastify.supabase
      .from('collection_items')
      .select('position, properties!inner(id, title, slug, description, cover_image_url, property_type, location_text, is_published, visibility)')
      .eq('collection_id', showcase.id)
      .eq('properties.is_published', true)
      .eq('properties.visibility', 'public')
      .order('position')
    if (itemsError) return reply.code(500).send({ statusMessage: 'Could not load showcase tours' })

    const tours = (items || []).map((item: any) => ({ position: item.position, ...item.properties })).filter(Boolean)
    reply.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return reply.send({ ...showcase, tours })
  })
}
