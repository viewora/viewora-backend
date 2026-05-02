import { FastifyInstance } from 'fastify'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { updateUploadStatus } from './uploads.js'

const MAX_WIDTH_PX  = 12288
const MAX_HEIGHT_PX = 6144

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const readable = body as NodeJS.ReadableStream
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any))
  }
  return Buffer.concat(chunks)
}

export async function processMedia(
  fastify: FastifyInstance,
  mediaId: string,
  objectKey: string,
  userId: string,
): Promise<void> {
  fastify.log.info({ mediaId, objectKey }, 'Starting media processing')

  const bucketName = process.env.R2_BUCKET_NAME
  if (!bucketName) throw new Error('R2_BUCKET_NAME not configured')

  try {
    // 1. Download original from R2
    const getResult = await fastify.s3.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectKey })
    )
    if (!getResult.Body) throw new Error(`Empty R2 body for key: ${objectKey}`)

    const originalBuffer = await streamToBuffer(getResult.Body)

    // 2. Read metadata — sharp strips all EXIF by default on output
    const image    = sharp(originalBuffer, { failOn: 'none' })
    const metadata = await image.metadata()
    const width    = metadata.width  ?? 0
    const height   = metadata.height ?? 0
    const fmt      = metadata.format ?? 'jpeg'

    // Reject oversized images to prevent OOM
    if (width > MAX_WIDTH_PX || height > MAX_HEIGHT_PX) {
      await updateUploadStatus(
        fastify, mediaId, 'failed',
        `Image too large: ${width}×${height}. Max allowed: ${MAX_WIDTH_PX}×${MAX_HEIGHT_PX}`,
      )
      return
    }

    // 3. Re-encode stripping EXIF, preserving original format at sane quality
    let cleanBuffer: Buffer
    let outContentType: string

    if (fmt === 'png') {
      cleanBuffer    = await image.png().toBuffer()
      outContentType = 'image/png'
    } else if (fmt === 'webp') {
      cleanBuffer    = await image.webp({ quality: 85 }).toBuffer()
      outContentType = 'image/webp'
    } else {
      // jpeg or anything else — output as progressive JPEG
      cleanBuffer    = await image.jpeg({ quality: 92, progressive: true }).toBuffer()
      outContentType = 'image/jpeg'
    }

    // 4. Re-upload stripped version back to R2 (same key, same CDN URL)
    await fastify.s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: cleanBuffer,
        ContentType: outContentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    )

    // 5. Persist confirmed dimensions to the media record
    await fastify.supabase
      .from('property_media')
      .update({ width: width || null, height: height || null })
      .eq('id', mediaId)

    fastify.log.info(
      { mediaId, width, height, fmt, originalBytes: originalBuffer.length, cleanBytes: cleanBuffer.length },
      'EXIF stripped and re-uploaded',
    )
    await updateUploadStatus(fastify, mediaId, 'complete')
  } catch (error: any) {
    fastify.log.error({ mediaId, objectKey, error: error?.message }, 'Media processing failed')
    throw error
  }
}
