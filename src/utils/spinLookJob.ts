import type { FastifyInstance } from 'fastify'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { studioPrefix } from './spinLook.js'
import { aiRestoreAvailable, replicateRestore } from './aiRestore.js'
import { keyFromAny, lookOf, progressKey, runSpinLook, type LookChoice, type SpinLookProgress } from './spinLook.js'

export const SPIN_LOOK_JOB = 'spin-look'
export interface SpinLookJob { spinId: string; spaceId: string; look: LookChoice }

/** How long progress is kept. Refreshed after every frame, so a crashed job's "working" expires. */
export const PROGRESS_TTL_S = 15 * 60

/**
 * Our media domains: the configured one, the production CDN (in case the worker has no
 * MEDIA_DOMAIN set), and the bucket's r2.dev address.
 */
export const mediaDomains = () => [
  process.env.MEDIA_DOMAIN,
  'https://media.viewora.software',
  process.env.R2_ACCOUNT_ID ? `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev` : undefined,
].filter((d): d is string => !!d)

type Redis = { setEx: (k: string, s: number, v: string) => Promise<unknown>; del: (k: string | string[]) => Promise<unknown> } | null

async function toBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of body as AsyncIterable<Buffer | Uint8Array>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

/** Worker side: puts a spin (and its other camera heights) on a look, then clears the tour cache. */
export async function processSpinLook(fastify: FastifyInstance, redis: Redis, data: SpinLookJob, finalAttempt: boolean): Promise<void> {
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) throw new Error('R2_BUCKET_NAME not configured')
  const progress = async (p: SpinLookProgress) => {
    await redis?.setEx(progressKey(data.spinId), PROGRESS_TTL_S, JSON.stringify(p)).catch(() => {})
  }
  try {
    const { data: rows } = await fastify.supabase.from('vehicle_spins').select('id').eq('row_of', data.spinId)
    const spinIds = [data.spinId, ...((rows ?? []) as { id: string }[]).map(r => r.id)]
    const result = await runSpinLook({
      mediaDomains: mediaDomains(),
      restore: aiRestoreAvailable() ? replicateRestore() : undefined,
      frames: async () => {
        const { data: views, error } = await fastify.supabase
          .from('vehicle_views').select('id, image_url, angle, spin_id').in('spin_id', spinIds)
        if (error) throw new Error(`Could not read the spin's photos: ${error.message}`)
        return (views ?? []) as any[]
      },
      read: async key => toBuffer((await fastify.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body),
      exists: async key => {
        try { await fastify.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true } catch { return false }
      },
      write: async (key, body) => {
        await fastify.s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }))
      },
      setUrls: async list => {
        for (let i = 0; i < list.length; i += 8) {
          const results = await Promise.all(list.slice(i, i + 8).map(r =>
            fastify.supabase.from('vehicle_views').update({ image_url: r.image_url }).eq('id', r.id)))
          const failed = results.find(r => r.error)
          if (failed?.error) throw new Error(`Could not save the new photos: ${failed.error.message}`)
        }
      },
      remove: async keys => {
        await Promise.all(keys.map(k => fastify.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })).catch(() => {})))
      },
      progress,
    }, data.look)

    // Buyers see the new look straight away, not after the 1-hour tour cache.
    const { data: space } = await fastify.supabase.from('properties').select('slug').eq('id', data.spaceId).maybeSingle()
    await redis?.del([`tour:${data.spaceId}`, ...(space?.slug ? [`tour:${space.slug}`] : [])]).catch(() => {})
    fastify.log.info({ ...data, changed: result.changed }, 'Spin look applied')
  } catch (err: any) {
    fastify.log.error({ ...data, err: err?.message }, 'Spin look failed')
    if (finalAttempt) await progress({ state: 'failed', look: data.look, done: 0, total: 0, error: 'We could not finish the photos. Your spin still shows its previous look. Try again in a few minutes.' })
    throw err
  }
}

// ── One-off: give every existing car the studio finish ──

/**
 * Set once the back-fill has queued its jobs; bump the version to run it again. v1 read frames 12 spins
 * a request and could miss cars; v2 reads each spin on its own.
 */
export const BACKFILL_VERSION = 2
export const BACKFILL_FLAG = `spin-look:backfill:v${BACKFILL_VERSION}`
/** Lower than an owner's own request (no priority = first), so uploads and clicks never wait on it. */
export const BACKFILL_PRIORITY = 10
/** Set (forever) when an owner picks a look themselves: the back-fill never overrides it. */
export const chosenKey = (spinId: string) => `spin-look:chosen:${spinId}`

type SpinRow = { id: string; space_id: string; row_of: string | null }
type ViewRow = { spin_id: string; image_url: string }

/** Main spins with photos, none of which has a look yet. */
export function spinsToBackfill(spins: SpinRow[], views: ViewRow[]): SpinRow[] {
  const mainOf = new Map(spins.map(s => [s.id, s.row_of ?? s.id]))
  const urls = new Map<string, string[]>()
  for (const v of views) {
    const main = mainOf.get(v.spin_id)
    if (!main) continue
    urls.set(main, [...(urls.get(main) ?? []), v.image_url])
  }
  return spins.filter(s => !s.row_of && (urls.get(s.id)?.length ?? 0) > 0 && urls.get(s.id)!.every(u => lookOf(u) === 'original'))
}

type Queue = { add: (name: string, data: any, opts?: any) => Promise<unknown> }
type FlagRedis = {
  set: (k: string, v: string, o: { NX: true }) => Promise<string | null>
  setEx: (k: string, s: number, v: string) => Promise<unknown>
  del: (k: string | string[]) => Promise<unknown>
  exists: (k: string) => Promise<number>
}
export interface BackfillDeps {
  /** True when finished copies of this original key are already in storage (finished before, then set back). */
  hasCopies: (originalKey: string) => Promise<boolean>
}

/** Every row of a table query, a page at a time (the API returns at most 1000 rows a request). */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

/**
 * Queues "studio" for every car that is still on its original frames, once (guarded by a Redis flag).
 * Runs when the worker starts. Skips a spin whose owner chose a look, or that was finished before and
 * set back to original. A failure clears the flag so the next start tries again.
 */
export async function queueSpinLookBackfill(fastify: FastifyInstance, redis: FlagRedis, queue: Queue, deps: BackfillDeps): Promise<number> {
  const got = await redis.set(BACKFILL_FLAG, new Date().toISOString(), { NX: true }).catch(() => null)
  if (got !== 'OK') return 0
  try {
    const all = await allRows<SpinRow>((a, b) => fastify.supabase.from('vehicle_spins').select('id, space_id, row_of').order('id').range(a, b))
    const views: ViewRow[] = []
    for (const s of all) { // one spin a request: at most 72 frames, never cut short
      views.push(...await allRows<ViewRow>((a, b) => fastify.supabase.from('vehicle_views').select('spin_id, image_url').eq('spin_id', s.id).range(a, b)))
    }
    const todo: SpinRow[] = []
    for (const s of spinsToBackfill(all, views)) {
      if (await redis.exists(chosenKey(s.id)).catch(() => 0)) continue
      const first = views.find(v => v.spin_id === s.id)
      const key = first && keyFromAny(first.image_url, mediaDomains())?.key
      if (key && await deps.hasCopies(key).catch(() => false)) continue
      todo.push(s)
    }
    for (const s of todo) {
      const progress: SpinLookProgress = { state: 'queued', look: 'natural', done: 0, total: 0 }
      await redis.setEx(progressKey(s.id), 2 * 60 * 60, JSON.stringify(progress)).catch(() => {})
      const job: SpinLookJob = { spinId: s.id, spaceId: s.space_id, look: 'natural' }
      // The version is in the id: BullMQ keeps failed jobs, and an add with a kept id is silently dropped.
      await queue.add(SPIN_LOOK_JOB, job, {
        jobId: `spin-look-backfill-v${BACKFILL_VERSION}-${s.id}`, priority: BACKFILL_PRIORITY, attempts: 3, backoff: { type: 'exponential', delay: 30_000 },
      })
    }
    fastify.log.info({ queued: todo.map(s => s.space_id), spins: all.length }, 'Studio finish back-fill queued')
    return todo.length
  } catch (err: any) {
    fastify.log.error({ err: err?.message }, 'Studio finish back-fill failed; will retry on next start')
    await redis.del(BACKFILL_FLAG).catch(() => {})
    return 0
  }
}

/** Storage check for the back-fill: any finished copy next to this original? */
export function r2HasCopies(fastify: FastifyInstance) {
  return async (originalKey: string) => {
    const bucket = process.env.R2_BUCKET_NAME
    if (!bucket) return false
    const out = await fastify.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: studioPrefix(originalKey), MaxKeys: 1 }))
    return (out.KeyCount ?? out.Contents?.length ?? 0) > 0
  }
}
