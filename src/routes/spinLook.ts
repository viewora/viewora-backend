import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { LOOK_CHOICES, progressKey, spinLookSummary, type LookChoice, type SpinLookProgress } from '../utils/spinLook.js'
import { PROGRESS_TTL_S, SPIN_LOOK_JOB, type SpinLookJob } from '../utils/spinLookJob.js'

// Studio finish for a car spin (owner only). The work runs in the worker: see utils/spinLookJob.ts.

const spinParams = z.object({ spinId: z.string().uuid() })
export const SpinLookBody = z.object({ look: z.enum(LOOK_CHOICES as [LookChoice, ...LookChoice[]]) })

export default async function spinLookRoutes(fastify: FastifyInstance) {
  /** The owner's main spin (a camera-height row is finished together with its main spin). */
  async function ownedSpin(spinId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_spins')
      .select('id, space_id, row_of, properties!inner(user_id)')
      .eq('id', spinId).eq('properties.user_id', userId).maybeSingle()
    return data as { id: string; space_id: string; row_of: string | null } | null
  }

  async function readProgress(spinId: string): Promise<SpinLookProgress | null> {
    if (!fastify.redis) return null
    const raw = await fastify.redis.get(progressKey(spinId)).catch(() => null)
    try { return raw ? JSON.parse(raw) : null } catch { return null }
  }

  /** The look the spin (and its camera heights) shows now, from the photos' URLs. */
  async function currentLook(spinId: string) {
    const { data: rows } = await fastify.supabase.from('vehicle_spins').select('id').eq('row_of', spinId)
    const ids = [spinId, ...((rows ?? []) as { id: string }[]).map(r => r.id)]
    const { data: views } = await fastify.supabase.from('vehicle_views').select('image_url').in('spin_id', ids)
    const urls = ((views ?? []) as { image_url: string }[]).map(v => v.image_url)
    return { ...spinLookSummary(urls), total: urls.length }
  }

  fastify.get('/vehicle-spins/:spinId/look', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spinParams, (req as any).params)
    if (!params) return
    const spin = await ownedSpin(params.spinId, userId)
    if (!spin) return reply.code(404).send({ statusMessage: 'Spin not found' })
    const [now, progress] = await Promise.all([currentLook(spin.row_of ?? spin.id), readProgress(spin.row_of ?? spin.id)])
    return reply.send({ ...now, progress })
  })

  fastify.post('/vehicle-spins/:spinId/look', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spinParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, SpinLookBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    const spin = await ownedSpin(params.spinId, userId)
    if (!spin) return reply.code(404).send({ statusMessage: 'Spin not found' })
    if (!fastify.uploadQueue) return reply.code(503).send({ statusMessage: 'Photo finishing is unavailable right now. Try again in a few minutes.' })

    const mainId = spin.row_of ?? spin.id
    const running = await readProgress(mainId)
    if (running && (running.state === 'queued' || running.state === 'working')) {
      return reply.code(409).send({ statusMessage: 'Still finishing the last change. It takes about a minute.', progress: running })
    }

    const progress: SpinLookProgress = { state: 'queued', look: body.look, done: 0, total: 0 }
    await fastify.redis?.setEx(progressKey(mainId), PROGRESS_TTL_S, JSON.stringify(progress)).catch(() => {})
    const job: SpinLookJob = { spinId: mainId, spaceId: spin.space_id, look: body.look }
    await fastify.uploadQueue.add(SPIN_LOOK_JOB, job, { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } })
    return reply.code(202).send({ progress })
  })
}
