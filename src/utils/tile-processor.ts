import sharp from 'sharp'
import path from 'path'
import fs from 'fs/promises'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const TILE_SIZE = 512
const TEMP_DIR  = process.env.TEMP_DIR ?? '/tmp/viewora-tiles'
const BATCH     = 20

export async function processTileScene(
  s3: S3Client,
  supabase: any,
  job: { sceneId: string; rawImageUrl: string; spaceId: string },
) {
  const { sceneId, rawImageUrl, spaceId } = job
  const tempDir       = path.join(TEMP_DIR, sceneId)
  const inputPath     = path.join(tempDir, 'input.jpg')
  const cleanPath     = path.join(tempDir, 'input.clean.jpg')
  const thumbPath     = path.join(tempDir, 'thumbnail.jpg')

  const bucket  = process.env.R2_BUCKET_NAME!
  const cdnBase = process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

  // SSRF guard — only allow fetches from our own CDN domain
  const allowedHost = new URL(cdnBase).hostname
  const rawUrlHost  = new URL(rawImageUrl).hostname
  if (rawUrlHost !== allowedHost) {
    throw new Error(`SSRF rejected: rawImageUrl hostname '${rawUrlHost}' is not '${allowedHost}'`)
  }

  try {
    console.log(`[TILE] Starting scene ${sceneId}`)
    await fs.mkdir(tempDir, { recursive: true })

    // 1. Download raw image (60s timeout)
    const dlController = new AbortController()
    const dlTimeout = setTimeout(() => dlController.abort(), 60_000)
    try {
      const res = await fetch(rawImageUrl, { signal: dlController.signal })
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
      await fs.writeFile(inputPath, Buffer.from(await res.arrayBuffer()))
    } finally {
      clearTimeout(dlTimeout)
    }

    // 2. Strip EXIF/GPS metadata (writes clean file, same quality)
    await sharp(inputPath)
      .jpeg({ quality: 95 })
      .toFile(cleanPath)

    // 3. Thumbnail 2048×1024 — used as PSV baseUrl (visible during tile loading)
    await sharp(cleanPath)
      .resize(2048, 1024, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 85, progressive: true })
      .toFile(thumbPath)

    const thumbKey = `spaces/${spaceId}/scenes/${sceneId}/thumbnail.jpg`
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: await fs.readFile(thumbPath),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }))

    // Mark scene ready immediately with thumbnail so editor isn't blocked
    await supabase.from('scenes').update({
      status: 'ready',
      thumbnail_url: `${cdnBase}/${thumbKey}`,
    }).eq('id', sceneId)
    console.log(`[TILE] Thumbnail ready for scene ${sceneId}`)

    // 4. Read dimensions once, then build PSV grid tile jobs
    const meta = await sharp(cleanPath).metadata()
    const imgW = meta.width  ?? 12288
    const imgH = meta.height ?? 6144
    const cols = Math.ceil(imgW / TILE_SIZE)
    const rows = Math.ceil(imgH / TILE_SIZE)

    // Load image once — each job clones to avoid re-reading the file
    const image = sharp(cleanPath)

    const tileJobs: Array<() => Promise<void>> = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * TILE_SIZE
        const top  = row * TILE_SIZE
        const w    = Math.min(TILE_SIZE, imgW - left)
        const h    = Math.min(TILE_SIZE, imgH - top)
        const key  = `spaces/${spaceId}/scenes/${sceneId}/tiles/${col}_${row}.webp`

        tileJobs.push(async () => {
          const buf = await image
            .clone()
            .extract({ left, top, width: w, height: h })
            .webp({ quality: 82 })
            .toBuffer()
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buf,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000, immutable',
          }))
        })
      }
    }

    // 5. Upload tiles in parallel batches of BATCH
    console.log(`[TILE] Uploading ${tileJobs.length} tiles (${cols}×${rows}) for scene ${sceneId}`)
    for (let i = 0; i < tileJobs.length; i += BATCH) {
      await Promise.all(tileJobs.slice(i, i + BATCH).map(fn => fn()))
    }

    // 6. Mark tiles_ready = true only after ALL tiles are uploaded
    const tileBase = `${cdnBase}/spaces/${spaceId}/scenes/${sceneId}/tiles`
    await supabase.from('scenes').update({
      tile_manifest_url: tileBase,
      width:       imgW,
      height:      imgH,
      tile_cols:   cols,
      tile_rows:   rows,
      tiles_ready: true,
    }).eq('id', sceneId)
    console.log(`[TILE] All tiles ready for scene ${sceneId} (${cols}×${rows})`)

  } catch (err: any) {
    await supabase.from('scenes').update({ status: 'failed' }).eq('id', sceneId)
    throw err
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
