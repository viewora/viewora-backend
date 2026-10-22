import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Queue } from 'bullmq'

import { fullResGrid } from './tileGrid.js'

// Scenes tiled before the grid change have full-res tiles of ~360–372px (32×16
// for 12K, 16×8 for 5.7K). A scene is "old" when its grid is finer than what
// fullResGrid() — the rule tile-processor now cuts with — gives for its size,
// so re-tiled scenes (and new uploads) match exactly and are never picked again.
const PAGE = 1000

type SceneRow = { id: string; space_id: string; raw_image_url: string; width: number | null; height: number | null; tile_cols: number | null; tile_rows: number | null }

function isOldGrid(s: SceneRow): boolean {
  if (!s.width || !s.height || !s.tile_cols || !s.tile_rows) return false
  const { cols, rows } = fullResGrid(s.width, s.height)
  return s.tile_cols > cols || s.tile_rows > rows
}

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
  // The grid check needs width/height, so it runs here rather than in the query;
  // page through every tiled scene and keep the old-grid ones.
  const old: SceneRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('scenes')
      .select('id, space_id, raw_image_url, width, height, tile_cols, tile_rows')
      .eq('tiles_ready', true)
      .not('raw_image_url', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    old.push(...((data ?? []) as SceneRow[]).filter(isOldGrid))
    if (!data || data.length < PAGE) break
  }
  const matching = old.length
  const scenes = old.slice(0, limit)

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
