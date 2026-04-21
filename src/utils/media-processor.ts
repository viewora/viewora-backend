import { FastifyInstance } from 'fastify'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { updateUploadStatus } from './uploads.js'

const MAX_WIDTH_PX = 4096
const MAX_HEIGHT_PX = 2048

async function streamToBuffer(body: unknown): Promise<Buffer> {
  // AWS SDK v3 Body is a Readable stream in Node.js
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

    const contentType = getResult.ContentType || 'image/jpeg'
    const originalBuffer = await streamToBuffer(getResult.Body)

    // 2. Process with sharp:
    //    - Strip ALL EXIF/XMP/IPTC metadata (removes GPS coordinates, device info, timestamps)
    //    - Read dimensions for DB record
    const image = sharp(originalBuffer, { failOn: 'none' })
    const metadata = await image.metadata()

    const width = metadata.width ?? 0
    const height = metadata.height ?? 0

    if (width > MAX_WIDTH_PX || height > MAX_HEIGHT_PX) {
      fastify.log.warn({ mediaId, width, height }, 'Image exceeds dimension limits — continuing anyway')
    }

    // sharp strips all EXIF/GPS/device metadata by default — calling .toBuffer() without
    // .withMetadata() is sufficient and is the correct sharp v0.33+ API.
    const cleanBuffer = await image.toBuffer()

    // 3. Re-upload stripped version back to R2 (same key, same CDN URL)
    await fastify.s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: cleanBuffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    )

    // 4. Persist confirmed dimensions to the media record
    await fastify.supabase
      .from('property_media')
      .update({ width: width || null, height: height || null })
      .eq('id', mediaId)

    fastify.log.info({ mediaId, width, height, originalBytes: originalBuffer.length, cleanBytes: cleanBuffer.length }, 'EXIF stripped and re-uploaded')
    await updateUploadStatus(fastify, mediaId, 'complete')
  } catch (error: any) {
    fastify.log.error({ mediaId, objectKey, error: error?.message }, 'Media processing failed')
    throw error
  }
}
