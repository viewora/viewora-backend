import type { FastifyInstance } from 'fastify'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { progressKey, runSpinLook, type LookChoice, type SpinLookProgress } from './spinLook.js'

export const SPIN_LOOK_JOB = 'spin-look'
export interface SpinLookJob { spinId: string; spaceId: string; look: LookChoice }

/** How long progress is kept. Refreshed after every frame, so a crashed job's "working" expires. */
export const PROGRESS_TTL_S = 15 * 60

export const mediaDomain = () => process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

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
      mediaDomain: mediaDomain(),
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
