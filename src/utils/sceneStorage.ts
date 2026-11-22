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
