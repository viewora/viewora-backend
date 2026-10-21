import { FastifyInstance } from 'fastify'
import { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { invalidateCacheBySceneId, invalidateSpaceCache, purgeSceneTiles } from '../utils/cache.js'
import { checkUserQuota, canCreateScene, quotaLimitMessage } from '../utils/quotas.js'

// ── Param schemas ─────────────────────────────────────────────
const sceneParamsSchema = z.object({ sceneId: z.string().uuid() })
const spaceParamsSchema = z.object({ spaceId: z.string().uuid() })

// ── Body schemas ─────────────────────────────────────────────
const CreateSceneBodySchema = z.object({
  name: z.string().min(1).max(100).default('Untitled Scene'),
  order_index: z.number().int().min(0).optional(),
  raw_image_url: z.string().url('Invalid image URL'),
  initial_yaw: z.number().min(-180).max(180).default(0),
  initial_pitch: z.number().min(-90).max(90).default(0),
})

// Explicit update schema.
// raw_image_url excluded: changing it without re-tiling corrupts state.
// status excluded: only the tile worker may change it.
const UpdateSceneBodySchema = z.object({
  name:          z.string().min(1).max(100).optional(),
  order_index:   z.number().int().min(0).optional(),
  initial_yaw:   z.number().min(-180).max(180).optional(),
  initial_pitch: z.number().min(-90).max(90).optional(),
  position_x:    z.number().optional(),
  // Category ("Kitchen", "Phase 2 plots"…). Empty string / null clears it.
  group_name:    z.string().trim().max(40).transform(v => (v ? v : null)).nullable().optional(),
  position_y:    z.number().optional(),
  // Floor-plan pin. x/y are fractions of the plan image; null unplaces the scene.
  floor_plan_id: z.string().uuid().nullable().optional(),
  plan_x:        z.number().min(0).max(1).nullable().optional(),
  plan_y:        z.number().min(0).max(1).nullable().optional(),
  north_offset:  z.number().min(-180).max(180).nullable().optional(),
})

const BulkCategoryBodySchema = z.object({
  scene_ids:  z.array(z.string().uuid()).min(1).max(500),
  // Same rules as group_name above: empty string / null clears the category.
  group_name: z.string().trim().max(40).transform(v => (v ? v : null)).nullable(),
})

export default async function scenesRoutes(fastify: FastifyInstance) {

  // ── LIST SCENES FOR A SPACE ────────────────────────────────
  fastify.get('/spaces/:spaceId/scenes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    // Run ownership check and scene fetch in parallel — halves DB round-trip time
    const [{ data: space }, { data: scenes, error }] = await Promise.all([
      fastify.supabase.from('properties').select('id').eq('id', params.spaceId).eq('user_id', userId).maybeSingle(),
      fastify.supabase.from('scenes').select('*, hotspots!scene_id(*)').eq('space_id', params.spaceId).order('order_index', { ascending: true }),
    ])

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch scenes' })
    }
    return reply.send({ scenes: scenes ?? [] })
  })

  // ── CREATE SCENE ──────────────────────────────────────────
  fastify.post('/spaces/:spaceId/scenes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateSceneBodySchema, req.body)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    // Subscription + scenes-per-tour quota check
    const quotaCtx = await checkUserQuota(fastify, userId)
    if (quotaCtx.isGrace) {
      return reply.code(403).send({ statusMessage: 'Scene creation is disabled during the grace period. Please renew your subscription.' })
    }
    if (!quotaCtx.canWrite) {
      return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
    }
    const allowed = await canCreateScene(fastify, params.spaceId, quotaCtx.plan)
    if (!allowed) {
      return reply.code(403).send({
        statusMessage: quotaLimitMessage(quotaCtx.plan, 'scenes'),
        code: 'SCENE_LIMIT_REACHED',
        limit: quotaCtx.plan.max_scenes_per_tour,
        plan: quotaCtx.plan.name,
      })
    }

    // Auto-assign next order_index if not supplied.
    // Fetch the current max and insert; if a concurrent create produces a duplicate
    // order_index (23505 on the unique constraint), retry once with a fresh max.
    const getNextOrderIndex = async () => {
      const { data: last } = await fastify.supabase
        .from('scenes')
        .select('order_index')
        .eq('space_id', params.spaceId)
        .order('order_index', { ascending: false })
        .limit(1)
        .maybeSingle()
      return (last?.order_index ?? -1) + 1
    }

    let orderIndex = body.order_index ?? await getNextOrderIndex()

    let scene: any
    let insertError: any
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await fastify.supabase
        .from('scenes')
        .insert({
          space_id:   params.spaceId,
          name:       body.name,
          order_index: orderIndex,
          raw_image_url: body.raw_image_url,
          initial_yaw:   body.initial_yaw,
          initial_pitch: body.initial_pitch,
          status:        'pending',
          position_x:    orderIndex * 3.0,
          position_y:    0,
        })
        .select()
        .single()
      scene = result.data
      insertError = result.error
      if (!insertError || insertError.code !== '23505') break
      // order_index collision — recalculate and retry
      orderIndex = await getNextOrderIndex()
    }

    if (insertError) {
      fastify.log.error(insertError)
      return reply.code(500).send({ statusMessage: 'Failed to create scene' })
    }

    // Enqueue tiling job on the existing uploadQueue
    if (fastify.uploadQueue) {
      await fastify.uploadQueue.add('tile-scene', {
        sceneId: scene.id,
        rawImageUrl: body.raw_image_url,
        spaceId: params.spaceId,
        userId,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      })
    }

    // Refresh the public cache — spaceId is already in scope, skip the extra scene→space lookup
    await invalidateSpaceCache(fastify, params.spaceId)

    return reply.code(201).send({ scene })
  })

  // ── GET SINGLE SCENE WITH HOTSPOTS ────────────────────────
  fastify.get('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return

    // Single query — ownership and scene data in one round-trip
    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('*, hotspots!scene_id(*), properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    return reply.send({ scene })
  })

  // ── UPDATE SCENE ──────────────────────────────────────────
  fastify.patch('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateSceneBodySchema, req.body)
    if (!body) return

    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    // A scene can only be pinned on a floor plan of its own space.
    if (body.floor_plan_id) {
      const { data: floorPlan } = await fastify.supabase
        .from('floor_plans')
        .select('id')
        .eq('id', body.floor_plan_id)
        .eq('space_id', (scene as any).space_id)
        .maybeSingle()
      if (!floorPlan) return reply.code(400).send({ statusMessage: 'Floor plan not found for this space' })
    }

    const { data: updated, error: updateError } = await fastify.supabase
      .from('scenes')
      .update(body)
      .eq('id', params.sceneId)
      .select()
      .single()

    if (updateError) {
      fastify.log.error(updateError)
      return reply.code(500).send({ statusMessage: 'Failed to update scene' })
    }

    // Invalidate public cache only after confirmed success
    await invalidateCacheBySceneId(fastify, params.sceneId)
    return reply.send({ scene: updated })
  })

  // ── SET CATEGORY FOR MANY SCENES ─────────────────────────
  // The editor's Organize tab categorises 100+ photos at once; one request
  // instead of one PATCH per scene keeps it well under the per-user rate limit.
  // Only scenes in this space are touched; ids from elsewhere are ignored.
  fastify.patch('/spaces/:spaceId/scenes/category', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, BulkCategoryBodySchema, req.body)
    if (!body) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const { data: updated, error } = await fastify.supabase
      .from('scenes')
      .update({ group_name: body.group_name })
      .in('id', [...new Set(body.scene_ids)])
      .eq('space_id', params.spaceId)
      .select('id')
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update categories' })
    }

    await invalidateSpaceCache(fastify, params.spaceId)
    const ids = (updated ?? []).map((s: any) => s.id)
    return reply.send({ updated: ids.length, scene_ids: ids, group_name: body.group_name })
  })

  // ── DELETE SCENE ──────────────────────────────────────────
  // CASCADE removes: (1) hotspots inside the scene, (2) nav arrows in OTHER scenes
  // that pointed to this scene (via hotspots_target_scene_id_fkey ON DELETE CASCADE).
  fastify.delete('/scenes/:sceneId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneParamsSchema, (req as any).params)
    if (!params) return

    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('id, space_id, raw_image_url, original_raw_image_url, properties!inner(user_id)')
      .eq('id', params.sceneId)
      .eq('properties.user_id', userId)
      .single()

    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    // Find the associated property_media record before deleting so we can free storage.
    // After an AI photo edit raw_image_url points at the edited copy — the upload is the original.
    const uploadedUrl = scene.original_raw_image_url ?? scene.raw_image_url
    const { data: mediaRecord } = uploadedUrl
      ? await fastify.supabase
          .from('property_media')
          .select('id, storage_key, file_size_bytes')
          .eq('property_id', scene.space_id)
          .eq('public_url', uploadedUrl)
          .maybeSingle()
      : { data: null }

    // Count cross-scene nav arrows that will be removed by the CASCADE before deleting
    const { count: removedLinks } = await fastify.supabase
      .from('hotspots')
      .select('id', { count: 'exact', head: true })
      .eq('target_scene_id', params.sceneId)

    const { error: deleteError } = await fastify.supabase.from('scenes').delete().eq('id', params.sceneId)
    if (deleteError) {
      fastify.log.error(deleteError, 'Failed to delete scene')
      return reply.code(500).send({ statusMessage: 'Failed to delete scene from database' })
    }

    // Delete the property_media record and decrement storage counter
    if (mediaRecord) {
      await fastify.supabase.from('property_media').delete().eq('id', mediaRecord.id)
      if (mediaRecord.file_size_bytes) {
        await fastify.supabase.rpc('decrement_storage_usage', { u_id: userId, bytes: Number(mediaRecord.file_size_bytes) })
      }
    }

    // Clean up R2: tiles directory + original panorama (best-effort)
    const bucketName = process.env.R2_BUCKET_NAME
    if (bucketName) {
      const tilesPrefix = `spaces/${scene.space_id}/scenes/${params.sceneId}/`
      try {
        // Paged: AI-edited scenes keep one tile set per version, easily >1000 objects
        let token: string | undefined
        do {
          const listed = await fastify.s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: tilesPrefix, ContinuationToken: token }))
          const objects = (listed.Contents ?? []).filter(o => o.Key).map(o => ({ Key: o.Key as string }))
          if (objects.length > 0) {
            await fastify.s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }))
          }
          token = listed.IsTruncated ? listed.NextContinuationToken : undefined
        } while (token)
      } catch (err) {
        fastify.log.error(err, `Failed to delete R2 tiles for scene ${params.sceneId}`)
      }
      if (mediaRecord?.storage_key) {
        try {
          await fastify.s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: mediaRecord.storage_key }))
        } catch (err) {
          fastify.log.error(err, `Failed to delete R2 panorama for scene ${params.sceneId}`)
        }
      }
    }

    // Bust billing cache so next quota check sees the freed storage
    if ((fastify as any).redis) {
      await (fastify as any).redis.del(`billing:status:${userId}`).catch(() => {})
      await purgeSceneTiles(fastify, params.sceneId)
    }

    // Resequence order_index for remaining scenes in the space so there are no gaps
    const { data: remaining } = await fastify.supabase
      .from('scenes')
      .select('id, order_index')
      .eq('space_id', scene.space_id)
      .order('order_index', { ascending: true })

    if (remaining?.length) {
      await Promise.all(
        remaining.map((s, i) =>
          s.order_index !== i
            ? fastify.supabase.from('scenes').update({ order_index: i }).eq('id', s.id)
            : Promise.resolve()
        )
      )
    }

    if (scene?.space_id) await invalidateSpaceCache(fastify, scene.space_id)

    return reply.send({ removedLinks: removedLinks ?? 0 })
  })

  // ── REPAIR SPACE ──────────────────────────────────────────
  // Cleans up leftover inconsistencies without requiring a full re-upload:
  //   • orphaned scene_link hotspots (target_scene_id IS NULL — legacy SET NULL artifacts)
  //   • gaps in order_index after bulk deletions
  //   • scenes stuck in pending/processing for >15 minutes (tile worker crash)
  fastify.post('/spaces/:spaceId/repair', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    // Fetch all scene IDs for this space
    const { data: sceneRows } = await fastify.supabase
      .from('scenes')
      .select('id, order_index, status, updated_at')
      .eq('space_id', params.spaceId)
      .order('order_index', { ascending: true })

    const sceneIds = (sceneRows ?? []).map(s => s.id)
    let orphansRemoved = 0
    let reordered = 0
    let stuckReset = 0

    if (sceneIds.length) {
      // 1. Remove orphaned scene_link hotspots (target_scene_id IS NULL)
      const { count } = await fastify.supabase
        .from('hotspots')
        .delete({ count: 'exact' })
        .in('scene_id', sceneIds)
        .eq('type', 'scene_link')
        .is('target_scene_id', null)
      orphansRemoved = count ?? 0

      // 2. Normalize order_index (fill gaps left by deletions)
      await Promise.all(
        (sceneRows ?? []).map((s, i) =>
          s.order_index !== i
            ? fastify.supabase.from('scenes').update({ order_index: i }).eq('id', s.id).then(() => { reordered++ })
            : Promise.resolve()
        )
      )

      // 3. Reset scenes stuck in pending/processing for >15 minutes
      const stuckCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const stuck = (sceneRows ?? []).filter(
        s => (s.status === 'pending' || s.status === 'processing') && s.updated_at < stuckCutoff
      )
      if (stuck.length) {
        await fastify.supabase
          .from('scenes')
          .update({ status: 'failed' })
          .in('id', stuck.map(s => s.id))
        stuckReset = stuck.length
      }
    }

    if (orphansRemoved || reordered || stuckReset) {
      await invalidateSpaceCache(fastify, params.spaceId)
    }

    fastify.log.info({ spaceId: params.spaceId, orphansRemoved, reordered, stuckReset }, '[repair] complete')
    return reply.send({ orphansRemoved, reordered, stuckReset })
  })

  // ── REPROCESS SCENES ─────────────────────────────────────
  // Re-queues tile-scene jobs for scenes in a space.
  // Default: only picks up failed/stuck scenes (status = failed/pending/processing).
  // With ?ktx2=true: also includes ready scenes that are missing KTX2 tiles —
  // use this to backfill KTX2 after deploying a worker build that has basisu.
  fastify.post('/spaces/:spaceId/reprocess', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParamsSchema, (req as any).params)
    if (!params) return

    const ktx2Mode = (req.query as any).ktx2 === 'true'

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', params.spaceId)
      .eq('user_id', userId)
      .single()
    if (!space) return reply.code(404).send({ statusMessage: 'Space not found.' })

    if (!fastify.uploadQueue) {
      return reply.code(503).send({ statusMessage: 'Worker queue unavailable — ensure REDIS_URL is set and the worker service is deployed.' })
    }

    let query = fastify.supabase
      .from('scenes')
      .select('id, space_id, raw_image_url')
      .eq('space_id', params.spaceId)
      .not('raw_image_url', 'is', null)

    if (ktx2Mode) {
      // KTX2 backfill: pick up ready scenes missing KTX2, plus any stuck scenes
      query = query.or('status.in.(failed,pending,processing),tile_medium_ktx2_manifest_url.is.null')
    } else {
      query = query.in('status', ['failed', 'pending', 'processing'])
    }

    const { data: scenesToProcess } = await query

    if (!scenesToProcess?.length) {
      return reply.send({ requeued: 0, message: ktx2Mode ? 'All scenes already have KTX2 tiles.' : 'No scenes need reprocessing.' })
    }

    await fastify.supabase
      .from('scenes')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .in('id', scenesToProcess.map(s => s.id))

    let requeued = 0
    for (const scene of scenesToProcess) {
      try {
        await purgeSceneTiles(fastify, scene.id)
        await fastify.uploadQueue.add('tile-scene', {
          sceneId: scene.id,
          rawImageUrl: scene.raw_image_url,
          spaceId: scene.space_id,
          userId,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        })
        requeued++
      } catch (err: any) {
        fastify.log.error({ sceneId: scene.id, error: err?.message }, 'reprocess: failed to re-queue')
      }
    }

    await invalidateSpaceCache(fastify, params.spaceId)
    fastify.log.info({ spaceId: params.spaceId, requeued, ktx2Mode }, '[reprocess] scenes re-queued')
    return reply.send({ requeued, message: `${requeued} scene(s) queued for reprocessing.` })
  })
}
