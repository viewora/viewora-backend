import { FastifyInstance } from 'fastify'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { checkStorageQuota, checkFileSizeLimit, isValidFileType, checkUserQuota } from '../utils/quotas.js'

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  // CREATE SIGNED URL
  fastify.post('/create-signed-url', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = request.body as any

    const { spaceId, propertyId, mediaType, fileName, contentType, fileSize } = body
    const finalId = spaceId || propertyId

    if (!finalId || !mediaType || !fileName || !contentType || !fileSize) {
      return reply.code(400).send({ statusMessage: 'Missing required fields' })
    }

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
      const mbLimit = Math.round(Number(plan.max_upload_bytes) / 1048576)
      return reply.code(413).send({ statusMessage: `File too large. Your plan allows up to ${mbLimit} MB per upload.` })
    }

    const hasSpace = await checkStorageQuota(fastify, userId, Number(fileSize))
    if (!hasSpace) {
      return reply.code(403).send({ statusMessage: 'Storage limit reached. Please upgrade your plan.' })
    }

    // 3. Verify Space Ownership
    const { data: space, error: spaceErr } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', finalId)
      .eq('user_id', userId)
      .single()

    if (spaceErr || !space) {
      return reply.code(403).send({ statusMessage: 'Unauthorized to upload to this space' })
    }

    // 4. Define path
    let folder = ''
    if (mediaType === 'panorama') folder = 'panorama'
    else if (mediaType === 'gallery') folder = 'gallery'
    else if (mediaType === 'thumb') folder = 'thumb'
    else if (mediaType === 'logo') folder = 'branding'
    else return reply.code(400).send({ statusMessage: 'Invalid media type' })

    const fileExt = fileName.split('.').pop()
    const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`
    
    let objectKey = `users/${userId}/spaces/${finalId}/${folder}/${uniqueFileName}`
    if (mediaType === 'logo') {
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
      ContentLength: Number(fileSize),
      CacheControl: cacheControl
    })

    try {
      const signedUrl = await getSignedUrl(fastify.s3, command, { expiresIn: 3600 })
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
  fastify.post('/complete', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const body = request.body as any

    const { spaceId, propertyId, mediaType, objectKey, publicUrl, width, height, fileSize } = body
    const finalId = spaceId || propertyId

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

    // 2. Insert record
    const { data: media, error: mediaErr } = await fastify.supabase
      .from('property_media')
      .insert({
        property_id: finalId,
        media_type: mediaType,
        storage_key: objectKey,
        public_url: publicUrl,
        width: width || null,
        height: height || null,
        file_size_bytes: fileSize || null
      })
      .select()
      .single()

    if (mediaErr) {
      fastify.log.error(mediaErr)
      return reply.code(500).send({ statusMessage: 'Failed to save media record' })
    }

    request.log.info({ userId, mediaId: media.id, size: fileSize, spaceId: finalId }, 'Completed media metadata R2 sync securely')

    // 3. Update storage counter via RPC
    if (fileSize) {
      await fastify.supabase.rpc('increment_storage_usage', { u_id: userId, bytes: Number(fileSize) })
    }

    return reply.send(media)
  })
}
