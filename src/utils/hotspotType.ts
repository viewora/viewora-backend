// Rules for editing a hotspot whose type may change (Move ⇄ Info ⇄ Media ⇄ Link).
// Pure, so PATCH /hotspots/:id and its tests share one definition.

export type HotspotType = 'info' | 'scene_link' | 'url' | 'video' | 'youtube'

type Row = {
  scene_id:         string
  type:             HotspotType
  target_scene_id:  string | null
  content:          Record<string, any> | null
}

type Patch = {
  type?:            HotspotType
  target_scene_id?: string | null
  content?:         Record<string, any> | null
  [k: string]:      unknown
}

/**
 * Checks the hotspot as it will be after the patch, and returns the patch to
 * write. A hotspot that stops being a Move loses its destination, so the
 * viewer never shows a stale link.
 */
export function resolveHotspotPatch(current: Row, body: Patch): { error: string } | { patch: Patch } {
  // Same type: behave exactly as before (moving an older hotspot must keep working).
  if (!body.type || body.type === current.type) return { patch: body }

  const type    = body.type
  const target  = 'target_scene_id' in body ? body.target_scene_id ?? null : current.target_scene_id
  const content = body.content !== undefined ? body.content : current.content
  const url     = typeof content?.url === 'string' ? content.url.trim() : ''

  if (type === 'scene_link') {
    if (!target) return { error: 'Pick the room this hotspot should go to.' }
    if (target === current.scene_id) return { error: 'A hotspot cannot link to its own scene.' }
  }
  if (type === 'url' && !url) return { error: 'Add the link this hotspot should open.' }
  if ((type === 'video' || type === 'youtube') && !url) return { error: 'Add the video link for this hotspot.' }

  const patch: Patch = { ...body }
  if (type !== 'scene_link' && current.target_scene_id) patch.target_scene_id = null
  return { patch }
}
