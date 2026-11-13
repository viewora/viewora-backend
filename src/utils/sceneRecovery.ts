/**
 * Gets scenes unstuck after an interruption (database outage, worker restart,
 * job lost from the queue): a scene still pending/processing well after its
 * upload is put back on the tile queue. Each scene is retried a few times;
 * after that it's marked failed so the editor stops waiting on it.
 *
 * Used by the editor's repair call (runs when the editor opens) and by the
 * recover-stuck-scenes sweep (every 10 minutes).
 */

/** How long a scene may sit in pending/processing before it counts as stuck. */
export const STUCK_AFTER_MS = 10 * 60 * 1000
/** Re-queues per scene before giving up and marking it failed. */
export const MAX_RECOVERIES = 3
const RECOVERY_TTL_S = 24 * 60 * 60

export interface StuckSceneRow {
  id: string
  space_id: string
  raw_image_url: string | null
  status: string | null
  updated_at: string | null
  created_at?: string | null
}

export interface RecoveryDeps {
  supabase: any
  queue: { add: (name: string, data: any, opts?: any) => Promise<any> } | null | undefined
  redis?: { incr: (key: string) => Promise<number>; expire: (key: string, s: number) => Promise<any> } | null
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void }
  now?: number
}

export function isStuck(scene: StuckSceneRow, now = Date.now()): boolean {
  if (scene.status !== 'pending' && scene.status !== 'processing') return false
  const stamp = Date.parse(scene.updated_at || scene.created_at || '')
  return Number.isFinite(stamp) && now - stamp > STUCK_AFTER_MS
}

/**
 * Re-queues the stuck scenes among `rows` (others are ignored). Returns how
 * many were re-queued and how many were given up on.
 */
export async function recoverStuckScenes(rows: StuckSceneRow[], userIdBySpace: Record<string, string | undefined>, deps: RecoveryDeps) {
  const now = deps.now ?? Date.now()
  const stuck = rows.filter(s => isStuck(s, now))
  let requeued = 0
  let failed = 0
  if (!stuck.length) return { requeued, failed }

  for (const scene of stuck) {
    // No photo to tile, or no queue to tile it on: nothing will ever finish it.
    let attempts = MAX_RECOVERIES + 1
    if (scene.raw_image_url && deps.queue) {
      attempts = 1
      if (deps.redis) {
        const key = `scene-recover:${scene.id}`
        try {
          attempts = await deps.redis.incr(key)
          if (attempts === 1) await deps.redis.expire(key, RECOVERY_TTL_S)
        } catch { attempts = 1 }
      }
    }

    if (attempts > MAX_RECOVERIES) {
      const { error } = await deps.supabase.from('scenes')
        .update({ status: 'failed', updated_at: new Date(now).toISOString() })
        .eq('id', scene.id).in('status', ['pending', 'processing'])
      if (error) deps.log?.error({ sceneId: scene.id, error: error.message }, 'scene recovery: could not mark failed')
      else failed++
      continue
    }

    // Stamp first: the next sweep then waits a full STUCK_AFTER_MS for this job.
    const { error } = await deps.supabase.from('scenes')
      .update({ status: 'pending', updated_at: new Date(now).toISOString() })
      .eq('id', scene.id).in('status', ['pending', 'processing'])
    if (error) {
      deps.log?.error({ sceneId: scene.id, error: error.message }, 'scene recovery: could not stamp scene')
      continue
    }
    try {
      await deps.queue!.add('tile-scene', {
        sceneId: scene.id,
        rawImageUrl: scene.raw_image_url,
        spaceId: scene.space_id,
        userId: userIdBySpace[scene.space_id],
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
      requeued++
      deps.log?.info({ sceneId: scene.id, attempt: attempts }, 'scene recovery: re-queued tile job')
    } catch (err: any) {
      deps.log?.error({ sceneId: scene.id, error: err?.message }, 'scene recovery: could not re-queue')
    }
  }
  return { requeued, failed }
}
