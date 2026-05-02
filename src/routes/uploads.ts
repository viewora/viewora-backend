import { FastifyInstance } from 'fastify'
import { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { checkStorageQuota, checkFileSizeLimit, isValidFileType, checkUserQuota } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'
import { scheduleMediaProcessing, updateUploadStatus } from '../utils/uploads.js'

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const uploadMediaTypeSchema = z.enum([
  'panorama',
  'gallery',
  'gallery_image',
  'thumb',
  'thumbnail',
  'logo',
  'floor_plan',
  'branding_logo',
  'audio',
])

const createSignedUrlBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  mediaType: uploadMediaTypeSchema,
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  fileSize: z.number().int().positive().max(250_000_000),
}).superRefine((data, ctx) => {
  const isBrandingUpload = data.mediaType === 'logo' || data.mediaType === 'branding_logo'
  if (!isBrandingUpload && !data.spaceId && !data.propertyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spaceId or propertyId is required',
      path: ['spaceId'],
    })
  }
})

const completeUploadBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  mediaType: uploadMediaTypeSchema,
  objectKey: z.string().trim().min(1).max(512),
  publicUrl: z.string().url().max(2048),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fileSize: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (!data.spaceId && !data.propertyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spaceId or propertyId is required',
      path: ['spaceId'],
    })
  }
})

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  // CREATE SIGNED URL
  fastify.post('/create-signed-url', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.user?.sub || request.ip,
      },
    },
  }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = parseWithSchema(reply, createSignedUrlBodySchema, request.body)
    if (!body) return

    const { spaceId, propertyId, mediaType, fileName, contentType, fileSize } = body
    const finalId = spaceId || propertyId

    // 1. Validate File Type
    if (!isValidFileType(contentType, mediaType)) {
      return reply.code(400).send({ statusMessage: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' })
    }

    // 2. Check subscription status and quotas
    const { plan, canWrite, isGrace } = await checkUserQuota(fastify, userId)

    if (isGrace) {
      return reply.code(403).send({ statusMessage: 'Uploads are disabled during the grace period. Please renew your subscription.' })
    }
    if (!canWrite) {
      return reply.code(403).send({ statusMessage: 'Your subscription is not active. Please check your billing status.' })
    }

    // Per-file size limit
    if (!checkFileSizeLimit(plan, Number(fileSize))) {
      const mbLimit = Math.round(Number(plan.max_upload_bytes || 15728640) / 1048576)
      return reply.code(413).send({ statusMessage: `File too large. Your plan allows up to ${mbLimit} MB per upload.` })
    }

    const hasSpace = await checkStorageQuota(fastify, userId, Number(fileSize))
    if (!hasSpace) {
      return reply.code(403).send({ statusMessage: 'Storage limit reached. Please upgrade your plan.' })
    }

    const isBrandingUpload = mediaType === 'logo' || mediaType === 'branding_logo'

    // 3. Verify Space Ownership for space-bound uploads
    if (!isBrandingUpload) {
      const { data: space, error: spaceErr } = await fastify.supabase
        .from('properties')
        .select('id')
        .eq('id', finalId)
        .eq('user_id', userId)
        .single()

      if (spaceErr || !space) {
        return reply.code(403).send({ statusMessage: 'Unauthorized to upload to this space' })
      }
    }

    // 4. Define path
    let folder = ''
    if (mediaType === 'panorama') folder = 'panorama'
    else if (mediaType === 'gallery' || mediaType === 'gallery_image') folder = 'gallery'
    else if (mediaType === 'thumb' || mediaType === 'thumbnail') folder = 'thumb'
    else if (mediaType === 'floor_plan') folder = 'floor_plan'
    else if (mediaType === 'audio') folder = 'audio'
    else if (mediaType === 'logo' || mediaType === 'branding_logo') folder = 'branding'
    else return reply.code(400).send({ statusMessage: 'Invalid media type' })

    // Sanitise extension: only allow alphanumeric chars, clamp to 8 chars.
    // Raw fileName comes from the client and must not influence the R2 key path.
    const rawExt = (fileName.split('.').pop() ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
    const fileExt = rawExt || 'bin'
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`
    
    let objectKey = `users/${userId}/spaces/${finalId}/${folder}/${uniqueFileName}`
    if (mediaType === 'logo' || mediaType === 'branding_logo') {
      objectKey = `users/${userId}/branding/${uniqueFileName}`
    }

    // 5. Generate Signed URL
    const bucketName = process.env.R2_BUCKET_NAME
    if (!bucketName) {
      fastify.log.error('R2_BUCKET_NAME missing')
      return reply.code(500).send({ statusMessage: 'Storage configuration error' })
    }

    const cacheControl = 'public, max-age=31536000, immutable'

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: contentType,
      CacheControl: cacheControl
      // ContentLength intentionally omitted: including it in the signature requires
      // browsers to send an exact Content-Length header, which some omit when streaming
      // a File body — causing R2 to reject the first attempt and triggering a retry.
    })

    try {
      const signedUrl = await getSignedUrl(fastify.s3, command, { expiresIn: 900 })
      const customDomain = process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`
      const publicUrl = `${customDomain}/${objectKey}`

      request.log.info({ userId, fileSize, type: mediaType, spaceId: finalId }, 'Generated secure R2 signed upload URL')
      return reply.send({
        signedUrl,
        objectKey,
        publicUrl
      })
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ statusMessage: 'Failed to generate upload URL' })
    }
  })

  // COMPLETE UPLOAD
  fastify.post('/complete', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.user?.sub || request.ip,
      },
    },
  }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = parseWithSchema(reply, completeUploadBodySchema, request.body)
    if (!body) return

    const { spaceId, propertyId, mediaType, objectKey, publicUrl, width, height, fileSize } = body
    const finalId = spaceId || propertyId

    if (!objectKey.startsWith(`users/${userId}/`)) {
      return reply.code(403).send({ statusMessage: 'Invalid object key ownership' })
    }

    // Verify the object was actually uploaded to R2 and capture actual size from storage
    const bucketName = process.env.R2_BUCKET_NAME
    let verifiedFileSize: number | null = fileSize ? Number(fileSize) : null
    if (bucketName) {
      try {
        const headResult = await fastify.s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }))
        if (headResult.ContentLength) verifiedFileSize = headResult.ContentLength
      } catch (err: any) {
        if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
          return reply.code(400).send({ statusMessage: 'Upload not found in storage. Please upload the file before completing.' })
        }
        fastify.log.warn({ objectKey, error: err?.message }, 'R2 HeadObject check failed — proceeding anyway')
      }
    }

    // 1. Verify Space Ownership
    const { data: space, error: spaceErr } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', finalId)
      .eq('user_id', userId)
      .single()

    if (spaceErr || !space) {
      return reply.code(403).send({ statusMessage: 'Unauthorized' })
    }

    // 2. Idempotency: if this objectKey is already registered for the same space, return it.
    const { data: existingMedia } = await fastify.supabase
      .from('property_media')
      .select('*')
      .eq('property_id', finalId)
      .eq('storage_key', objectKey)
      .maybeSingle()

    if (existingMedia) {
      if (existingMedia.processing_status === 'failed') {
        await updateUploadStatus(fastify, existingMedia.id, 'pending')
        if (finalId) {
          scheduleMediaProcessing(
            fastify,
            existingMedia.id,
            finalId,
            userId,
            existingMedia.storage_key
          )
        }
      }

      request.log.info({ userId, mediaId: existingMedia.id, objectKey }, 'Upload completion idempotent hit')
      return reply.send(existingMedia)
    }

    // 3. Insert record
    let dbMediaType = mediaType
    if (mediaType === 'gallery') dbMediaType = 'gallery_image'
    if (mediaType === 'thumb')   dbMediaType = 'thumbnail'
    
    const { data: media, error: mediaErr } = await fastify.supabase
      .from('property_media')
      .insert({
        property_id: finalId,
        media_type: dbMediaType,
        storage_key: objectKey,
        public_url: publicUrl,
        width: width || null,
        height: height || null,
        file_size_bytes: verifiedFileSize || null,
        processing_status: 'pending'
      })
      .select()
      .single()

    if (mediaErr) {
      fastify.log.error(mediaErr)
      return reply.code(500).send({ statusMessage: 'Failed to save media record' })
    }

    const { data: mediaTypes } = await fastify.supabase
      .from('property_media')
      .select('media_type')
      .eq('property_id', finalId)

    const uploadedTypes = new Set((mediaTypes || []).map((item: any) => item.media_type))
    await fastify.supabase
      .from('properties')
      .update({
        has_360: uploadedTypes.has('panorama'),
        has_gallery: uploadedTypes.has('gallery_image'),
      })
      .eq('id', finalId)

    request.log.info({ userId, mediaId: media.id, size: verifiedFileSize, spaceId: finalId }, 'Completed media metadata R2 sync securely')

    // 4. Update storage counter via RPC (uses R2-verified size, not client-reported)
    if (verifiedFileSize) {
      await fastify.supabase.rpc('increment_storage_usage', { u_id: userId, bytes: verifiedFileSize })
    }

    if (finalId) {
      scheduleMediaProcessing(fastify, media.id, finalId, userId, objectKey)
    }

    return reply.send(media)
  })

  // RETRY MEDIA PROCESSING
  fastify.post('/:id/retry-processing', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data: media, error: fetchErr } = await fastify.supabase
      .from('property_media')
      .select('id, processing_status, storage_key, property_id, properties!inner(user_id)')
      .eq('id', id)
      .eq('properties.user_id', userId)
      .single()

    if (fetchErr || !media) {
      return reply.code(404).send({ statusMessage: 'Media not found or unauthorized' })
    }

    if (media.processing_status === 'processing') {
      return reply.code(409).send({ statusMessage: 'Media is already processing' })
    }

    await updateUploadStatus(fastify, media.id, 'pending')
    scheduleMediaProcessing(fastify, media.id, media.property_id, userId, media.storage_key)

    return reply.send({ mediaId: media.id, status: 'pending' })
  })

  // DELETE MEDIA
  fastify.delete('/:id', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    // 1. Get media record to verify ownership and get storage info
    const { data: media, error: fetchErr } = await fastify.supabase
      .from('property_media')
      .select('id, media_type, storage_key, file_size_bytes, property_id, properties!inner(user_id)')
      .eq('id', id)
      .eq('properties.user_id', userId)
      .single()

    if (fetchErr || !media) {
      return reply.code(404).send({ statusMessage: 'Media not found or unauthorized' })
    }

    // 2. Delete from Cloudflare R2
    const bucketName = process.env.R2_BUCKET_NAME
    if (bucketName && media.storage_key) {
      try {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: media.storage_key
        })
        await fastify.s3.send(deleteCommand)
      } catch (err) {
        fastify.log.error(err, 'Failed to delete object from R2 during media cleanup')
      }
    }

    // 3. Delete from Database
    const { error: deleteErr } = await fastify.supabase
      .from('property_media')
      .delete()
      .eq('id', id)

    if (deleteErr) {
      return reply.code(500).send({ statusMessage: 'Failed to delete media record' })
    }

    if (media.media_type === 'panorama') {
      await fastify.supabase
        .from('property_360_settings')
        .delete()
        .eq('property_id', media.property_id)
    }

    const { data: remainingMedia } = await fastify.supabase
      .from('property_media')
      .select('media_type')
      .eq('property_id', media.property_id)

    const remainingTypes = new Set((remainingMedia || []).map((item: any) => item.media_type))
    await fastify.supabase
      .from('properties')
      .update({
        has_360: remainingTypes.has('panorama'),
        has_gallery: remainingTypes.has('gallery_image'),
      })
      .eq('id', media.property_id)

    // 4. Decrement Storage Quota
    if (media.file_size_bytes) {
      await fastify.supabase.rpc('decrement_storage_usage', { u_id: userId, bytes: Number(media.file_size_bytes) })
    }

    request.log.info({ userId, mediaId: id, size: media.file_size_bytes }, 'Deleted media and synced R2/Quota')
    return reply.code(204).send()
  })
}
