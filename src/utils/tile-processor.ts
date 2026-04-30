import sharp from 'sharp'
import path from 'path'
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const TILE_SIZE = 512
const TEMP_DIR  = process.env.TEMP_DIR ?? '/tmp/viewora-tiles'

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    files.push(...(e.isDirectory() ? await walk(full) : [full]))
  }
  return files
}

export async function processTileScene(
  s3: S3Client,
  supabase: any,
  job: { sceneId: string; rawImageUrl: string; spaceId: string },
) {
  const { sceneId, rawImageUrl, spaceId } = job
  const tempDir    = path.join(TEMP_DIR, sceneId)
  const inputPath  = path.join(tempDir, 'input.jpg')
  const tilesDir   = path.join(tempDir, 'tiles')

  // Use the same env var names as the rest of the codebase
  const bucket  = process.env.R2_BUCKET_NAME!
  const cdnBase = process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

  try {
    console.log(`[TILE PROCESSOR] Starting tile generation for scene: ${sceneId}... This usually takes ~60 seconds.`)
    await fs.mkdir(tempDir, { recursive: true })

    // 1. Download raw image from R2 CDN
    const res = await fetch(rawImageUrl)
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    await fs.writeFile(inputPath, Buffer.from(await res.arrayBuffer()))

    // 2. Generate DZI tiles (512px, no overlap, deep-zoom format)
    // Use high quality (95) and progressive for the best viewing experience.
    await sharp(inputPath)
      .jpeg({ quality: 95, progressive: true, chromaSubsampling: '4:4:4' })
      .tile({ size: TILE_SIZE, overlap: 0, layout: 'dz', container: 'fs' })
      .toFile(tilesDir)

    const dziFile      = tilesDir + '.dzi'
    const tileFilesDir = tilesDir + '_files'

    // 3. Generate thumbnail (400x200 for scene picker UI)
    const thumbPath = path.join(tempDir, 'thumbnail.jpg')
    await sharp(inputPath)
      .resize(400, 200, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath)

    // 4. Upload DZI manifest
    const dziKey = `spaces/${spaceId}/scenes/${sceneId}/tiles.dzi`
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: dziKey,
      Body: await fs.readFile(dziFile),
      ContentType: 'application/xml',
      CacheControl: 'public, max-age=31536000, immutable',
    }))

    // 5. Upload all tile image files
    for (const filePath of await walk(tileFilesDir)) {
      const relPath = path.relative(tileFilesDir, filePath)
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `spaces/${spaceId}/scenes/${sceneId}/tiles_files/${relPath}`,
        Body: createReadStream(filePath),
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }))
    }

    // 6. Upload thumbnail
    const thumbKey = `spaces/${spaceId}/scenes/${sceneId}/thumbnail.jpg`
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: await fs.readFile(thumbPath),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }))

    // 7. Mark scene as ready in DB
    await supabase.from('scenes').update({
      status: 'ready',
      tile_manifest_url: `${cdnBase}/${dziKey}`,
      thumbnail_url: `${cdnBase}/${thumbKey}`,
    }).eq('id', sceneId)
    console.log(`[TILE PROCESSOR] Successfully generated and uploaded tiles for scene: ${sceneId}`)

  } catch (err: any) {
    // Mark as failed so the UI can show a retry option
    await supabase.from('scenes').update({ status: 'failed' }).eq('id', sceneId)
    throw err // Re-throw so BullMQ handles retries
  } finally {
    // Always clean up temp files
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
