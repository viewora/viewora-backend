import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Queue } from 'bullmq'

// Scenes tiled before the grid change have 32×16 full-res tiles of ~372px;
// tile-processor now cuts 16×8 (~744px for 12K). Anything above 16 cols is old.
const OLD_GRID_MIN_COLS = 16
const PAGE = 1000

export interface RetileResult {
  matching: number
  queued: number
  sceneIds: string[]
}

/**
 * Re-queues scenes still on the old full-res grid.
 * Each job writes into a fresh `v/retile-…` folder: tiles are immutable-cached
 * and the old/new grids share file names, so overwriting in place would mix
 * stale tiles into the new grid. The scene keeps serving its old tiles until
 * the job flips tile_manifest_url at the end.
 * Safe to run repeatedly: re-tiled scenes no longer match, and the fixed jobId
 * dedupes scenes whose job is still waiting/active (completed jobs are removed,
 * so a failed re-tile can be retried later).
 */
export async function queueRetileScenes(
  supabase: SupabaseClient,
  queue: Queue,
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<RetileResult> {
  const limit = opts.limit ?? Infinity
  const scenes: Array<{ id: string; space_id: string; raw_image_url: string }> = []
  let matching = 0

  for (let from = 0; scenes.length < limit; from += PAGE) {
    const to = from + Math.min(PAGE, limit - scenes.length) - 1
    const { data, count, error } = await supabase
      .from('scenes')
      .select('id, space_id, raw_image_url', { count: 'exact' })
      .gt('tile_cols', OLD_GRID_MIN_COLS)
      .eq('tiles_ready', true)
      .not('raw_image_url', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, to)
    if (error) throw error
    matching = count ?? 0
    scenes.push(...(data ?? []))
    if (!data?.length || to + 1 >= matching) break
  }

  if (opts.dryRun) return { matching, queued: 0, sceneIds: scenes.map(s => s.id) }

  let queued = 0
  for (const scene of scenes) {
    // Lowest priority so customers' new uploads are never stuck behind a backfill.
    await queue.add('tile-scene', {
      sceneId: scene.id,
      rawImageUrl: scene.raw_image_url,
      spaceId: scene.space_id,
      variant: `retile-${randomUUID()}`,
    }, {
      jobId: `retile-${scene.id}`,
      priority: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    })
    queued++
  }

  return { matching, queued, sceneIds: scenes.map(s => s.id) }
}
