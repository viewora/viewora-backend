// A scene's files (thumbnail, tiles, AI edits, spotlights) live under
// spaces/<space id>/scenes/<scene id>/ in R2, using the space the scene was
// processed in. A scene moved to another tour (POST /spaces/:id/move-scenes)
// keeps its files where they are, so its folder can name the OLD space. Cleanup
// uses both: the current space's folder and the one its own file URLs point at.

const SCENE_FOLDER = /(spaces\/[0-9a-f-]{36}\/scenes\/[0-9a-f-]{36}\/)/i

export function sceneStoragePrefixes(
  spaceId: string,
  scene: { id: string; thumbnail_url?: string | null; tile_manifest_url?: string | null; tile_medium_manifest_url?: string | null },
): string[] {
  const prefixes = new Set([`spaces/${spaceId}/scenes/${scene.id}/`])
  for (const url of [scene.thumbnail_url, scene.tile_manifest_url, scene.tile_medium_manifest_url]) {
    const m = url ? SCENE_FOLDER.exec(url) : null
    // Only this scene's own folder — never something a URL happens to contain.
    if (m && m[1].toLowerCase().includes(`/scenes/${scene.id.toLowerCase()}/`)) prefixes.add(m[1])
  }
  return [...prefixes]
}

/**
 * Which of these R2 folders / keys some scene or upload row still uses — copies made
 * by "Add to existing tour" (migration-add-scenes-to-tour.sql) share files with their
 * originals, so delete routes skip anything listed here. Without the migration no
 * copies can exist, so a missing function means "nothing shared".
 */
export async function filesStillUsed(
  supabase: { rpc: (fn: string, args: any) => PromiseLike<{ data: any; error: any }> },
  prefixes: string[],
  keys: string[],
  skipMediaIds: string[] = [],
  log?: { warn: (obj: any, msg?: string) => void },
): Promise<Set<string>> {
  if (!prefixes.length && !keys.length) return new Set()
  const { data, error } = await supabase.rpc('files_still_used', {
    p_prefixes: prefixes, p_keys: keys, p_skip_media: skipMediaIds,
  })
  if (error) {
    const missing = error.code === 'PGRST202' || error.code === '42883'
    if (!missing) {
      // Unknown state: keep everything rather than risk deleting a file another tour shows.
      log?.warn(error, 'files_still_used failed — keeping the files')
      return new Set([...prefixes, ...keys])
    }
    return new Set()
  }
  return new Set((data as string[] | null) ?? [])
}
