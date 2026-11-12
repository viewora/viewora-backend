import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'

// Link previews (WhatsApp, Facebook, X, LinkedIn, Telegram, iMessage).
//
// Crawlers give up on slow or heavy images, and a 2–6 MB panorama or car photo
// resized on the fly is both. So every listing gets one 1200×630 JPEG (~100 KB),
// made once with sharp and stored in R2 under a key derived from its source
// image. It is served from the media domain with an immutable Cache-Control, so
// Cloudflare keeps it at the edge and every later share is a cache hit. A new
// cover or new car photos give a new source URL, so a new key and a fresh preview.

export const SHARE_W = 1200
export const SHARE_H = 630
const WAIT_MS = 2500                       // longest the tour request waits for a first render
const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export type ShareImage = { url: string; width: number; height: number }

/** The picture a listing is shared with: a car's front exterior frame, else the cover,
 *  else the first room, else the first gallery photo. */
export function shareImageSource(tour: any): string | null {
  const spin = (tour?.vehicle_spins ?? [])[0]
  if (spin?.views?.length) {
    const start = Number(spin.start_angle ?? 0)
    const gap = (a: number) => { const d = Math.abs(((a - start) % 360 + 360) % 360); return Math.min(d, 360 - d) }
    const front = [...spin.views].sort((a: any, b: any) => gap(Number(a.angle ?? 0)) - gap(Number(b.angle ?? 0)))[0]
    if (isHttp(front?.image_url)) return front.image_url
  }
  const candidates = [
    tour?.space?.cover_image_url,
    tour?.scenes?.[0]?.thumbnail_url,
    tour?.gallery?.[0]?.url,
  ]
  return candidates.find(isHttp) ?? null
}

export function shareImageKey(spaceId: string, source: string): string {
  return `og/${spaceId}/${createHash('sha1').update(source).digest('hex').slice(0, 16)}.jpg`
}

function isHttp(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//.test(u)
}

function mediaBase(): string {
  return (process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`).replace(/\/$/, '')
}

/** 1200×630, centred crop, progressive JPEG — small enough for any crawler. */
export async function renderShareImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'none', limitInputPixels: false })
    .rotate()
    .resize(SHARE_W, SHARE_H, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#0a0a0a' })
    .jpeg({ quality: 78, progressive: true, mozjpeg: true })
    .toBuffer()
}

const known = new Set<string>()                       // keys already in R2 (this process)
const pending = new Map<string, Promise<boolean>>()   // renders in flight

async function ensure(fastify: FastifyInstance, key: string, source: string): Promise<boolean> {
  if (known.has(key)) return true
  const redisKey = `og:${key}`
  if (fastify.redis && await fastify.redis.get(redisKey).catch(() => null)) { known.add(key); return true }

  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket || !fastify.s3) return false
  const done = () => {
    known.add(key)
    if (fastify.redis) void fastify.redis.setEx(redisKey, 30 * 86400, '1').catch(() => {})
    return true
  }
  try {
    await fastify.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return done()
  } catch { /* not there yet */ }

  const res = await fetch(source, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`share image source ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_SOURCE_BYTES) throw new Error('share image source too large')
  const body = await renderShareImage(Buffer.from(await res.arrayBuffer()))
  await fastify.s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return done()
}

/**
 * The listing's share preview. Renders it on first use, waiting at most WAIT_MS;
 * if that is not enough the render carries on in the background and this returns
 * null, so the page falls back to its own image this one time.
 */
export async function shareImageFor(fastify: FastifyInstance, tour: any): Promise<ShareImage | null> {
  const spaceId = tour?.space?.id
  const source = shareImageSource(tour)
  if (!spaceId || !source) return null
  const key = shareImageKey(spaceId, source)
  const url = `${mediaBase()}/${key}`
  if (known.has(key)) return { url, width: SHARE_W, height: SHARE_H }

  let job = pending.get(key)
  if (!job) {
    job = ensure(fastify, key, source)
      .catch(err => { fastify.log.warn({ err, spaceId }, 'Share image render failed'); return false })
      .finally(() => pending.delete(key))
    pending.set(key, job)
  }
  const ok = await Promise.race([job, new Promise<false>(r => setTimeout(r, WAIT_MS, false))])
  return ok ? { url, width: SHARE_W, height: SHARE_H } : null
}

/** What a link preview needs, kept apart from the full tour so crawlers get it in milliseconds. */
export interface ShareMeta {
  slug: string
  title: string
  /** "2018 Lexus RX 350": a car's name, when it has one. */
  vehicle: string | null
  description: string | null
  image: ShareImage | null
  /** White-label tours carry no Viewora name. */
  white_label: boolean
  space_type: string | null
}

export function shareMeta(tour: any, slug: string): ShareMeta {
  const s = tour?.space ?? {}
  const model = [s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ')
  const vehicle = model ? [s.vehicle_year, model, s.vehicle_trim].filter(Boolean).join(' ') : null
  const raw = shareImageSource(tour)
  return {
    slug,
    title: String(s.title || 'Virtual tour'),
    vehicle,
    description: typeof s.description === 'string' && s.description.trim() ? s.description.trim().slice(0, 300) : null,
    image: tour?.share_image ?? (raw ? { url: raw, width: 0, height: 0 } : null),
    white_label: !!s.branding_enabled,
    space_type: s.space_type ?? null,
  }
}

export const shareMetaKey = (slug: string) => `share:${slug}`
