import { randomUUID } from 'node:crypto'
import { viewForRegion, type SphericalPoint } from './aiImageEdit.js'
import { viewPixelToSpherical, viewPointToYawPitch, VIEW_YAWS_DEG } from './panoViews.js'

// Turns the AI assistant's raw JSON actions into validated, ready-to-apply
// proposals. The model refers to scenes/hotspots as S1/H1, never UUIDs, so it
// can only touch what is in the owner's tour; positions are converted from
// view/area/panorama coordinates to hotspot yaw/pitch here.

const DEG_TO_RAD = Math.PI / 180
export const MAX_ACTIONS = 25

const INFO_ICON: Record<string, string> = { feature: 'info-3d-light', view: 'camera-3d-light', highlight: 'star-yellow' }
const SIZE_SCALE: Record<string, number> = { small: 0.8, medium: 1, large: 1.3 }

// ── Types ────────────────────────────────────────────────────────────────────
export type Proposal = {
  id:       string
  kind:     'create_hotspot' | 'update_hotspot' | 'delete_hotspot' | 'update_scene' | 'update_listing' | 'edit_image'
  summary:  string
  why:      string
  sceneId?: string
  sceneName?: string
  hotspotId?: string
  payload?: Record<string, any>   // create_hotspot → POST body; update_* → PATCH body
  instruction?: string            // edit_image
  corners?: SphericalPoint[]      // edit_image
}

export type Ctx = {
  scope:      'tour' | 'scene' | 'region'
  focusId:    string | null
  sceneRef:   Map<string, any>     // S1 → scene row
  hotspotRef: Map<string, any>     // H1 → hotspot row
  areaView?:  ReturnType<typeof viewForRegion>
  region?:    SphericalPoint[]
  prompt:     string
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function isBox(b: unknown): b is number[] {
  return Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && n >= 0 && n <= 1000) && b[2] > b[0] && b[3] > b[1]
}

/** Resolves an "at" position to panorama yaw/pitch (radians) + apparent size and, for boxes, corners. */
export function resolveAt(at: any, sceneRow: any, ctx: Ctx): { yaw: number; pitch: number; sizeDeg?: number; corners?: SphericalPoint[] } | null {
  const isFocus = sceneRow.id === ctx.focusId
  if (at === 'area' && ctx.region && isFocus && ctx.areaView) {
    const { view, mask } = ctx.areaView
    return { ...viewPixelToSpherical(view, (mask.x0 + mask.x1) / 2, (mask.y0 + mask.y1) / 2), corners: ctx.region }
  }
  if (at && typeof at === 'object') {
    if (isBox(at.area_box) && ctx.areaView && isFocus) {
      const [ymin, xmin, ymax, xmax] = at.area_box
      const { view } = ctx.areaView
      const px = (n: number) => n / 1000 * view.size
      const corners = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]].map(([x, y]) => viewPixelToSpherical(view, px(x), px(y)))
      const top = viewPixelToSpherical(view, px((xmin + xmax) / 2), px(ymin)).pitch
      const bot = viewPixelToSpherical(view, px((xmin + xmax) / 2), px(ymax)).pitch
      return { ...viewPixelToSpherical(view, px((xmin + xmax) / 2), px((ymin + ymax) / 2)), sizeDeg: (top - bot) / DEG_TO_RAD, corners }
    }
    if (isBox(at.box_2d) && Number.isInteger(at.view) && at.view >= 1 && at.view <= VIEW_YAWS_DEG.length && isFocus) {
      const [ymin, xmin, ymax, xmax] = at.box_2d
      const v = at.view - 1
      // edit areas get a 10% margin so the fill blends past the object's edge
      const mx = (xmax - xmin) * 0.1, my = (ymax - ymin) * 0.1
      const cl = (n: number) => Math.max(0, Math.min(1000, n))
      const corners = [[xmin - mx, ymin - my], [xmax + mx, ymin - my], [xmax + mx, ymax + my], [xmin - mx, ymax + my]]
        .map(([x, y]) => viewPointToYawPitch(v, cl(x), cl(y)))
      const top = viewPointToYawPitch(v, (xmin + xmax) / 2, ymin).pitch
      const bot = viewPointToYawPitch(v, (xmin + xmax) / 2, ymax).pitch
      return { ...viewPointToYawPitch(v, (xmin + xmax) / 2, (ymin + ymax) / 2), sizeDeg: (top - bot) / DEG_TO_RAD, corners }
    }
    if (Array.isArray(at.point) && at.point.length === 2 && at.point.every((n: any) => typeof n === 'number' && n >= 0 && n <= 1000)) {
      const [y, x] = at.point
      return { yaw: (x / 1000 - 0.5) * 2 * Math.PI, pitch: (0.5 - y / 1000) * Math.PI }
    }
  }
  return null
}

function scaleFromSize(size: unknown, sizeDeg: number | undefined, nav: boolean): number {
  if (typeof size === 'string' && SIZE_SCALE[size]) return SIZE_SCALE[size]
  if (sizeDeg == null) return 1
  const raw = nav ? sizeDeg / 40 : 0.8 + sizeDeg / 100
  const [lo, hi] = nav ? [0.7, 1.4] : [0.8, 1.2]
  return Math.round(Math.min(hi, Math.max(lo, raw)) * 20) / 20
}

function urlFromPrompt(url: unknown, prompt: string): string | null {
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) return null
  return prompt.includes(url) ? url : null   // never accept a link the owner didn't type
}

function labelColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined
}

const round4 = (n: number) => parseFloat(n.toFixed(4))

/** Turns the model's raw actions into validated, ready-to-apply proposals. */
export function toProposals(actions: any[], ctx: Ctx, canEditImages: boolean): Proposal[] {
  const out: Proposal[] = []
  const id = () => randomUUID()

  for (const a of actions.slice(0, MAX_ACTIONS)) {
    const why = clean(a?.why, 120)
    switch (a?.type) {
      case 'create_hotspot': {
        const scene = ctx.sceneRef.get(a.scene)
        if (!scene) break
        const pos = resolveAt(a.at, scene, ctx)
        if (!pos) break
        const kind = ['info', 'scene_link', 'url', 'youtube', 'video'].includes(a.kind) ? a.kind : 'info'
        const label = clean(a.label, 60)
        const payload: Record<string, any> = { type: kind, yaw: round4(pos.yaw), pitch: round4(pos.pitch), label }
        const category = INFO_ICON[a.category] ? a.category : 'feature'
        const content: Record<string, any> = { scale: scaleFromSize(a.size, pos.sizeDeg, kind === 'scene_link') }
        if (kind === 'scene_link') {
          const target = ctx.sceneRef.get(a.target)
          if (!target || target.id === scene.id) break
          payload.target_scene_id = target.id
          if (!label) payload.label = target.name || 'Next room'
          content.icon = 'nav-up'
        } else if (kind === 'info') {
          if (!label) break
          content.text  = clean(a.description, 500)
          content.icon  = INFO_ICON[category]
          if (category === 'highlight') content.label_bold = true
        } else {
          const url = urlFromPrompt(a.url, ctx.prompt)
          if (!url) break
          content.url = url
          if (kind === 'url') content.button_label = 'Open link'
        }
        const lc = labelColor(a.label_color)
        if (lc) content.label_color = lc
        payload.content = content
        out.push({
          id: id(), kind: 'create_hotspot', why, sceneId: scene.id, sceneName: scene.name, payload,
          summary: kind === 'scene_link'
            ? `Add arrow in ${scene.name || 'scene'} → ${ctx.sceneRef.get(a.target)?.name || 'scene'}`
            : `Add ${kind === 'info' ? (category === 'highlight' ? 'highlight' : 'info') : kind} hotspot “${payload.label || kind}” in ${scene.name || 'scene'}`,
        })
        break
      }

      case 'update_hotspot': {
        const h = ctx.hotspotRef.get(a.hotspot)
        if (!h) break
        const scene = [...ctx.sceneRef.values()].find(s => s.id === h.scene_id)
        const body: Record<string, any> = {}
        const label = clean(a.label, 60)
        if (label && label !== h.label) body.label = label
        if (a.at !== undefined && scene) {
          const pos = resolveAt(a.at, scene, ctx)
          if (pos) { body.yaw = round4(pos.yaw); body.pitch = round4(pos.pitch) }
        }
        // content is replaced wholesale by PATCH — merge onto what's there
        const content = { ...(h.content ?? {}) }
        let contentChanged = false
        const desc = clean(a.description, 500)
        if (desc && h.type === 'info') { content.text = desc; contentChanged = true }
        if (typeof a.size === 'string' && SIZE_SCALE[a.size]) { content.scale = SIZE_SCALE[a.size]; contentChanged = true }
        if (INFO_ICON[a.category] && h.type === 'info') {
          content.icon = INFO_ICON[a.category]
          content.label_bold = a.category === 'highlight' || undefined
          contentChanged = true
        }
        const lc = labelColor(a.label_color)
        if (lc) { content.label_color = lc; contentChanged = true }
        if (contentChanged) body.content = content
        if (!Object.keys(body).length) break
        const what = [body.label && 'rename', body.yaw != null && 'move', body.content && 'restyle'].filter(Boolean).join(', ')
        out.push({
          id: id(), kind: 'update_hotspot', why, sceneId: h.scene_id, sceneName: scene?.name, hotspotId: h.id, payload: body,
          summary: `Edit “${h.label || 'hotspot'}” (${what})${body.label ? ` → “${body.label}”` : ''}`,
        })
        break
      }

      case 'delete_hotspot': {
        const h = ctx.hotspotRef.get(a.hotspot)
        if (!h) break
        const scene = [...ctx.sceneRef.values()].find(s => s.id === h.scene_id)
        out.push({
          id: id(), kind: 'delete_hotspot', why, sceneId: h.scene_id, sceneName: scene?.name, hotspotId: h.id,
          summary: `Remove “${h.label || 'hotspot'}” from ${scene?.name || 'scene'}`,
        })
        break
      }

      case 'update_scene': {
        const scene = ctx.sceneRef.get(a.scene)
        if (!scene) break
        const body: Record<string, any> = {}
        const name  = clean(a.name, 100)
        const group = clean(a.group, 40)
        if (name && name !== scene.name) body.name = name
        if (group && group !== scene.group_name) body.group_name = group
        if (a.start_view !== undefined) {
          const pos = resolveAt(a.start_view, scene, ctx)
          // scenes.initial_yaw/pitch are DEGREES (viewora-app domain/scene resolveStartView)
          if (pos) { body.initial_yaw = Math.round(pos.yaw / DEG_TO_RAD); body.initial_pitch = Math.round(pos.pitch / DEG_TO_RAD) }
        }
        if (!Object.keys(body).length) break
        const parts = [body.name && `rename to “${body.name}”`, body.group_name && `category “${body.group_name}”`, body.initial_yaw != null && 'new opening view']
        out.push({
          id: id(), kind: 'update_scene', why, sceneId: scene.id, sceneName: scene.name, payload: body,
          summary: `${scene.name || 'Scene'}: ${parts.filter(Boolean).join(', ')}`,
        })
        break
      }

      case 'update_listing': {
        const body: Record<string, any> = {}
        const description = typeof a.description === 'string' ? a.description.trim().slice(0, 2000) : ''
        const title = clean(a.title, 120)
        if (description) body.description = description
        if (title) body.title = title
        if (!Object.keys(body).length) break
        out.push({
          id: id(), kind: 'update_listing', why, payload: body,
          summary: [title && `New title “${title}”`, description && 'Rewrite listing description'].filter(Boolean).join(' · '),
        })
        break
      }

      case 'edit_image': {
        if (!canEditImages || ctx.scope === 'tour') break
        const scene = ctx.sceneRef.get(a.scene)
        const instruction = clean(a.instruction, 500)
        if (!scene || !instruction) break
        const pos = resolveAt(a.at, scene, ctx)
        if (!pos?.corners) break
        out.push({
          id: id(), kind: 'edit_image', why, sceneId: scene.id, sceneName: scene.name, instruction, corners: pos.corners,
          summary: `Photo edit in ${scene.name || 'scene'}: ${instruction}`,
        })
        break
      }
    }
  }
  return out
}
