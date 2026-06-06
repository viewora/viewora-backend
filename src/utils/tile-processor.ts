import sharp from 'sharp'
// Disable sharp cache to prevent OOM on large panoramas
sharp.cache(false)
// Limit sharp to 1 CPU thread to save memory overhead per tile
sharp.concurrency(1)
import path from 'path'
import fs from 'fs/promises'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const TILE_SIZE        = 512
const MEDIUM_MAX_WIDTH = 4096
const MEDIUM_MAX_HEIGHT = 2048
const TEMP_DIR         = process.env.TEMP_DIR ?? '/tmp/viewora-tiles'
const BATCH            = 10
const MAX_WIDTH        = 12288
const MAX_HEIGHT       = 6144

function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1
  return Math.pow(2, Math.ceil(Math.log2(n)))
}

// Pull DateTimeOriginal from raw EXIF bytes without an external parser.
// Camera EXIF embeds dates as ASCII "YYYY:MM:DD HH:MM:SS" — a regex scan is
// reliable enough for all major 360 cameras (Insta360, GoPro, Ricoh Theta).
function parseExifCaptureDate(exifBuf: Buffer): Date | null {
  try {
    const str = exifBuf.toString('binary')
    const match = str.match(/(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/)
    if (!match) return null
    const [datePart, timePart] = match[1].split(' ')
    const d = new Date(`${datePart.replace(/:/g, '-')}T${timePart}Z`)
    return isNaN(d.getTime()) ? null : d
  } catch { return null }
}

export async function processTileScene(
  s3: S3Client,
  supabase: any,
  job: { sceneId: string; rawImageUrl: string; spaceId: string },
  redis?: { del: (key: string) => Promise<any> } | null,
) {
  const { sceneId, rawImageUrl, spaceId } = job
  const tempDir       = path.join(TEMP_DIR, sceneId)
  const inputPath     = path.join(tempDir, 'input.jpg')
  const cleanPath     = path.join(tempDir, 'input.clean.jpg')
  const processedPath = path.join(tempDir, 'input.processed.jpg')
  const mediumPath    = path.join(tempDir, 'input.medium.jpg')
  const thumbPath     = path.join(tempDir, 'thumbnail.jpg')

  const bucket  = process.env.R2_BUCKET_NAME!
  // Ensure we use the custom domain for public URLs
  const cdnBase = 'https://media.viewora.software'

  // SSRF guard — only allow fetches from our own domains
  const rawUrlHost  = new URL(rawImageUrl).hostname

  const isAllowed = 
    rawUrlHost === 'media.viewora.software' || 
    rawUrlHost === 'viewora.software' ||
    rawUrlHost.endsWith('.r2.dev') ||
    rawUrlHost.endsWith('.cloudflare.com')

  if (!isAllowed) {
    throw new Error(`SSRF rejected: rawImageUrl hostname '${rawUrlHost}' is not an authorized Viewora or R2 domain.`)
  }

  try {
    console.log(`[TILE] >>> STEP 1: Starting scene ${sceneId}`);
    await fs.mkdir(tempDir, { recursive: true })

    // 1. Download raw image (60s timeout)
    const dlController = new AbortController()
    const dlTimeout = setTimeout(() => dlController.abort(), 120_000)
    try {
      console.log(`[TILE] >>> STEP 2: Downloading raw image from ${rawImageUrl}`);
      const res = await fetch(rawImageUrl, { signal: dlController.signal })
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
      await fs.writeFile(inputPath, Buffer.from(await res.arrayBuffer()))
      console.log(`[TILE] >>> STEP 3: Download complete (${(await fs.stat(inputPath)).size} bytes)`);
    } finally {
      clearTimeout(dlTimeout)
    }

    // 2. Read EXIF capture date BEFORE stripping (it's gone afterwards)
    const rawMeta = await sharp(inputPath).metadata()
    const capturedAt = rawMeta.exif ? parseExifCaptureDate(rawMeta.exif) : null
    if (capturedAt) console.log(`[TILE] Capture date from EXIF: ${capturedAt.toISOString()}`)

    // 3. Strip EXIF/GPS metadata (writes clean file, same quality)
    console.log(`[TILE] >>> STEP 4: Stripping metadata...`);
    await sharp(inputPath)
      .jpeg({ quality: 95 })
      .toFile(cleanPath)
    console.log(`[TILE] >>> STEP 5: Metadata stripped`);

    // 3b. Server-side tone-mapping — applied before tiling and thumbnail so the viewer
    // receives display-ready textures without needing any shader correction.
    // Gamma 2.3 decode + 2.2 encode lifts shadow detail; saturation 1.1 adds subtle pop.
    console.log(`[TILE] >>> STEP 5b: Applying tone-mapping...`);
    await sharp(cleanPath)
      .gamma(2.3, 2.2)
      .modulate({ saturation: 1.1, brightness: 1.02 })
      .jpeg({ quality: 95 })
      .toFile(processedPath)
    console.log(`[TILE] >>> STEP 5c: Tone-mapping complete`);

    // 3c. Thumbnail 2048×1024 — used as PSV baseUrl (visible during tile loading)
    console.log(`[TILE] >>> STEP 6: Generating thumbnail...`);
    await sharp(processedPath)
      .resize(2048, 1024, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 92, progressive: true })
      .toFile(thumbPath)
    console.log(`[TILE] >>> STEP 7: Thumbnail generated`);

    const thumbKey = `spaces/${spaceId}/scenes/${sceneId}/thumbnail.jpg`
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: await fs.readFile(thumbPath),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }))

    // Mark scene ready immediately with thumbnail so editor isn't blocked
    const thumbUrl = `${cdnBase}/${thumbKey}`
    await supabase.from('scenes').update({
      status: 'ready',
      thumbnail_url: thumbUrl,
      ...(capturedAt ? { captured_at: capturedAt.toISOString() } : {}),
    }).eq('id', sceneId)

    // Auto-set tour cover image and 360 flag if missing
    await supabase.from('properties')
      .update({ cover_image_url: thumbUrl, has_360: true })
      .eq('id', spaceId)
      .or('cover_image_url.is.null,cover_image_url.eq.""')

    console.log(`[TILE] Thumbnail ready for scene ${sceneId}`)

    // 4. Read dimensions once, then build PSV grid tile jobs
    const meta = await sharp(processedPath).metadata()
    const imgW = meta.width  ?? 12288
    const imgH = meta.height ?? 6144

    // Reject images that are too small to produce a usable 360° sphere.
    // A 2:1 equirectangular under 2000px wide renders as a blurry blur at any
    // zoom level. Fail early with a clear status rather than silently uploading
    // a 2×1 grid that looks broken in the viewer.
    const MIN_WIDTH = 200
    if (imgW < MIN_WIDTH) {
      console.warn(`[TILE] Scene ${sceneId} rejected: source image is ${imgW}×${imgH}px (minimum width ${MIN_WIDTH}px for a usable 360° panorama)`)
      const storageKey = new URL(rawImageUrl).pathname.replace(/^\//, '')
      await Promise.all([
        supabase.from('scenes').update({ status: 'failed' }).eq('id', sceneId),
        storageKey
          ? supabase.from('property_media').update({ processing_status: 'failed' }).eq('storage_key', storageKey)
          : Promise.resolve(),
      ])
      return
    }

    if (imgW > MAX_WIDTH || imgH > MAX_HEIGHT) {
      console.warn(`[TILE] Scene ${sceneId} rejected: image ${imgW}×${imgH}px exceeds max ${MAX_WIDTH}×${MAX_HEIGHT}px`)
      const storageKey = new URL(rawImageUrl).pathname.replace(/^\//, '')
      await Promise.all([
        supabase.from('scenes').update({ status: 'failed' }).eq('id', sceneId),
        storageKey
          ? supabase.from('property_media').update({ processing_status: 'failed' }).eq('storage_key', storageKey)
          : Promise.resolve(),
      ])
      return
    }

    // PSV EquirectangularTilesAdapter requires cols and rows to be powers of 2.
    // We snap up to the next power of 2, then compute even tile dimensions so
    // every tile fits the grid without fractional pixels.
    const cols  = nextPowerOfTwo(Math.ceil(imgW / TILE_SIZE))
    const rows  = nextPowerOfTwo(Math.ceil(imgH / TILE_SIZE))
    const tileW = Math.ceil(imgW / cols)
    const tileH = Math.ceil(imgH / rows)

    // Load image once — each job clones to avoid re-reading the file
    const image = sharp(processedPath)

    const tileJobs: Array<() => Promise<void>> = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * tileW
        const top  = row * tileH
        const w    = Math.min(tileW, imgW - left)
        const h    = Math.min(tileH, imgH - top)
        const key  = `spaces/${spaceId}/scenes/${sceneId}/tiles/${col}_${row}.webp`

        tileJobs.push(async () => {
          const buf = await image
            .clone()
            .extract({ left, top, width: w, height: h })
            .webp({ quality: 90 })
            .toBuffer()
          // Retry up to 3 times with exponential backoff so a single R2 blip
          // doesn't force a full re-tile of all 72+ tiles.
          let lastErr: unknown
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: buf,
                ContentType: 'image/webp',
                CacheControl: 'public, max-age=31536000, immutable',
              }))
              return
            } catch (err) {
              lastErr = err
              if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
            }
          }
          throw lastErr
        })
      }
    }

    // 5. Upload tiles in parallel batches of BATCH
    console.log(`[TILE] Uploading ${tileJobs.length} tiles (${cols}×${rows} grid, ${tileW}×${tileH}px each) for scene ${sceneId}`)
    for (let i = 0; i < tileJobs.length; i += BATCH) {
      await Promise.all(tileJobs.slice(i, i + BATCH).map(fn => fn()))
    }

    // 5b. Generate medium-resolution tile set (≤4096×2048) for lite/mobile viewers.
    // These are served instead of the full tile set on constrained devices, trading
    // some sharpness for dramatically reduced bandwidth and VRAM usage.
    const mMaxW = Math.min(imgW, MEDIUM_MAX_WIDTH)
    const mMaxH = Math.min(imgH, MEDIUM_MAX_HEIGHT)
    await sharp(processedPath)
      .resize(mMaxW, mMaxH, { fit: 'fill', withoutEnlargement: true })
      .jpeg({ quality: 88, progressive: true })
      .toFile(mediumPath)

    const mediumMeta = await sharp(mediumPath).metadata()
    const mW = mediumMeta.width  ?? mMaxW
    const mH = mediumMeta.height ?? mMaxH
    const mCols  = nextPowerOfTwo(Math.ceil(mW / TILE_SIZE))
    const mRows  = nextPowerOfTwo(Math.ceil(mH / TILE_SIZE))
    const mTileW = Math.ceil(mW / mCols)
    const mTileH = Math.ceil(mH / mRows)

    const mediumImage = sharp(mediumPath)
    const mediumJobs: Array<() => Promise<void>> = []
    for (let row = 0; row < mRows; row++) {
      for (let col = 0; col < mCols; col++) {
        const left = col * mTileW
        const top  = row * mTileH
        const w    = Math.min(mTileW, mW - left)
        const h    = Math.min(mTileH, mH - top)
        const key  = `spaces/${spaceId}/scenes/${sceneId}/tiles_medium/${col}_${row}.webp`
        mediumJobs.push(async () => {
          const buf = await mediumImage
            .clone()
            .extract({ left, top, width: w, height: h })
            .webp({ quality: 85 })
            .toBuffer()
          let lastErr: unknown
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: buf,
                ContentType: 'image/webp',
                CacheControl: 'public, max-age=31536000, immutable',
              }))
              return
            } catch (err) {
              lastErr = err
              if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
            }
          }
          throw lastErr
        })
      }
    }

    console.log(`[TILE] Uploading ${mediumJobs.length} medium tiles (${mCols}×${mRows}) for scene ${sceneId}`)
    for (let i = 0; i < mediumJobs.length; i += BATCH) {
      await Promise.all(mediumJobs.slice(i, i + BATCH).map(fn => fn()))
    }

    const mediumTileBase = `${cdnBase}/spaces/${spaceId}/scenes/${sceneId}/tiles_medium`

    // 6. Mark tiles_ready = true only after ALL tiles are uploaded
    const tileBase = `${cdnBase}/spaces/${spaceId}/scenes/${sceneId}/tiles`
    // 6. Update BOTH tables to unlock publishing
    await Promise.all([
      // Update the scene itself
      supabase.from('scenes').update({
        tile_manifest_url:        tileBase,
        width:                    imgW,
        height:                   imgH,
        tile_cols:                cols,
        tile_rows:                rows,
        tile_medium_manifest_url: mediumTileBase,
        tile_medium_cols:         mCols,
        tile_medium_rows:         mRows,
        tiles_ready:              true,
        status:                   'ready'
      }).eq('id', sceneId),

      // Update the media record so the 'Publish' button is unlocked
      // Extract just the path portion (after the domain) regardless of which domain is used
      supabase.from('property_media').update({
        processing_status: 'complete',
        processed_at:      new Date().toISOString()
      }).eq('storage_key', new URL(rawImageUrl).pathname.replace(/^\//, ''))
    ])
    
    // Invalidate the public cache so the viewer switches to tiled mode immediately
    if (redis) {
      const { data: prop } = await supabase.from('properties').select('slug').eq('id', spaceId).single()
      if (prop?.slug) {
        await redis.del(`tour:${prop.slug}`).catch(() => {})
      }
    }
    console.log(`[TILE] All tiles ready for scene ${sceneId} (${cols}×${rows})`)

  } catch (err: any) {
    console.error(`[TILE] !!! CRITICAL ERROR on scene ${sceneId}: ${err.message}`);
    console.error(`[TILE] STACK: ${err.stack}`);
    const storageKey = new URL(rawImageUrl).pathname.replace(/^\//, '')
    await Promise.all([
      supabase.from('scenes').update({ status: 'failed' }).eq('id', sceneId),
      storageKey
        ? supabase.from('property_media').update({ processing_status: 'failed' }).eq('storage_key', storageKey)
        : Promise.resolve(),
    ])
    throw err
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
