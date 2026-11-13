// Navigation arrows from floor-plan pins — no AI, no image analysis.
//
// Each scene pinned on a floor plan has a position (plan_x / plan_y, fractions
// of the plan image) and a facing direction (north_offset: degrees clockwise
// from the top of the plan that the panorama's centre faces — the viewer's
// minimap cone points at yaw + north_offset). So the direction from one pin to
// another, minus north_offset, is exactly where the arrow goes in the scene.
//
// Like Matterport's floor circles, each arrow sits on the floor where the next
// camera stood: nearer scenes low and big, farther ones higher and smaller, so
// visitors can jump straight to a scene further along.

import { titleCase, type NavSuggestion } from './autoLinkPlan.js'

export type PinnedScene = {
  id:            string
  name:          string
  floor_plan_id: string | null
  plan_x:        number | null
  plan_y:        number | null
  north_offset:  number | null
}

export type FloorInfo = { id: string; name: string; width: number | null; height: number | null }

export type FloorPlanLinkResult = {
  suggestions:  NavSuggestion[]
  unpinned:     Array<{ id: string; name: string }>   // not on any floor plan
  noDirection:  Array<{ id: string; name: string }>   // pinned, but facing never set
  loneFloors:   string[]                              // floor names with a single pin
}

const DEG = Math.PI / 180
export const FLOOR_NAV_ICON = 'nav-floor-pin'

// Pin spacing is in plan pixels and plans have no scale, so distances are
// measured in "typical steps": the median gap to each pin's nearest neighbour.
// A typical step is assumed to be ~2.5 m, and the camera ~1.5 m high — only
// used to tilt the arrow down onto the floor at a believable spot.
const STEP_M        = 2.5
const CAMERA_M      = 1.5
const MAX_PER_SCENE = 6
const REACH_STEPS   = 2.6    // farthest link, in typical steps…
const REACH_OWN_NN  = 2.4    // …or in this scene's own nearest-neighbour gaps, whichever is larger
const SECTOR_DEG    = 14     // arrows closer than this in direction share a "sector"
const PER_SECTOR    = 2      // the next scene in a direction, and one skip-ahead behind it

const wrap = (r: number) => { let a = r % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a }
const round4 = (n: number) => parseFloat(n.toFixed(4))

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

export function planFloorPlanLinks(opts: {
  scenes:      PinnedScene[]
  floors:      FloorInfo[]
  linkedPairs: Set<string>
  zones?:      Map<string, string>     // car interiors (interiorZones) — never on the walk
}): FloorPlanLinkResult {
  const { scenes, floors, linkedPairs, zones = new Map() } = opts
  const floorById = new Map(floors.map(f => [f.id, f]))
  const res: FloorPlanLinkResult = { suggestions: [], unpinned: [], noDirection: [], loneFloors: [] }

  const byFloor = new Map<string, PinnedScene[]>()
  for (const s of scenes) {
    if (zones.has(s.id)) continue
    if (!s.floor_plan_id || s.plan_x == null || s.plan_y == null || !floorById.has(s.floor_plan_id)) {
      res.unpinned.push({ id: s.id, name: s.name })
      continue
    }
    byFloor.set(s.floor_plan_id, [...(byFloor.get(s.floor_plan_id) ?? []), s])
  }

  for (const [floorId, pins] of byFloor) {
    const floor = floorById.get(floorId)!
    if (pins.length < 2) { res.loneFloors.push(floor.name); continue }
    // Fractions → plan pixels, so a wide plan's x and y are measured alike.
    const W = floor.width || 1000, H = floor.height || 1000
    const pt = pins.map(p => ({ x: p.plan_x! * W, y: p.plan_y! * H }))
    const dist = (i: number, j: number) => Math.hypot(pt[j].x - pt[i].x, pt[j].y - pt[i].y)

    const nn = pins.map((_, i) => Math.min(...pins.map((_, j) => (i === j ? Infinity : dist(i, j)))))
    const step = median(nn.filter(d => d > 0)) || 1

    pins.forEach((from, i) => {
      if (from.north_offset == null) { res.noDirection.push({ id: from.id, name: from.name }); return }
      const reach = Math.max(REACH_STEPS * step, REACH_OWN_NN * nn[i])
      const near = pins
        .map((to, j) => ({ to, j, d: dist(i, j) }))
        .filter(c => c.j !== i && c.d > 0 && c.d <= reach)
        .sort((a, b) => a.d - b.d)

      const kept: Array<{ to: PinnedScene; d: number; yaw: number }> = []
      for (const c of near) {
        if (kept.length >= MAX_PER_SCENE) break
        // Plan bearing: clockwise from the top of the plan (y grows downwards).
        const bearing = Math.atan2(pt[c.j].x - pt[i].x, -(pt[c.j].y - pt[i].y))
        const yaw = wrap(bearing - from.north_offset * DEG)
        const sameWay = kept.filter(k => Math.abs(wrap(k.yaw - yaw)) < SECTOR_DEG * DEG).length
        if (sameWay >= PER_SECTOR) continue
        kept.push({ to: c.to, d: c.d, yaw })
      }

      kept.forEach((k, rank) => {
        if (linkedPairs.has(`${from.id}:${k.to.id}`)) return
        const metres = (k.d / step) * STEP_M
        const pitch = -Math.min(50, Math.max(6, Math.atan2(CAMERA_M, metres) / DEG)) * DEG
        const steps = k.d / step
        res.suggestions.push({
          fromSceneId: from.id, fromSceneName: from.name,
          toSceneId:   k.to.id, toSceneName:   k.to.name,
          yaw: round4(k.yaw), pitch: round4(pitch),
          label: titleCase(k.to.name || 'Next scene'),
          doorwayDescription: rank === 0 ? 'Nearest on the floor plan' : steps > 1.6 ? 'Further along — skip ahead' : 'Nearby on the floor plan',
          icon: FLOOR_NAV_ICON,
          // Farther = smaller, like markers receding on a floor.
          scale: Math.round(Math.min(1.1, Math.max(0.6, 1.2 - 0.18 * steps)) * 20) / 20,
          confidence_hint: Math.max(50, 95 - rank * 8),
        })
      })
    })
  }
  return res
}
