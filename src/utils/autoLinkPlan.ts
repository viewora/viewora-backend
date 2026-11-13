// Pure navigation planning for auto-link: turns per-scene doorway detections
// into scene_link suggestions. No I/O, so it is unit tested directly
// (src/tests/autoLinkPlan.test.ts).
//
// Every detected doorway is matched to the scene it actually leads to —
// not only the next/previous scene in upload order — so a scene gets as many
// arrows as it has walkable openings, and visitors can skip ahead.

export type DoorwayKind = 'door' | 'archway' | 'stairs_up' | 'stairs_down' | 'outdoor'

export type PlanDoorway = {
  position_pct:    number          // 0-100 across the panorama (50 = centre)
  pitch_deg:       number          // where the arrow goes (floor at the threshold)
  size_deg:        number          // apparent height of the opening
  kind:            DoorwayKind
  leads_to:        string          // AI's words: "kitchen", "hallway"…
  target?:         number          // AI's pick: 1-based scene number, 0/undefined = unsure
  confidence:      number
}

export type PlanScene = {
  id:        string
  name:      string
  roomType?: string     // from this run's analysis
  newName?:  string     // from this run's analysis
}

export type NavSuggestion = {
  fromSceneId: string; fromSceneName: string
  toSceneId:   string; toSceneName:   string
  yaw: number; pitch: number
  label: string; doorwayDescription: string
  icon: string; scale: number
  confidence_hint: number
}

export const NAV_ICON          = 'nav-up'
const DEG_TO_RAD               = Math.PI / 180
export const DEFAULT_PITCH_RAD = -8 * DEG_TO_RAD
const DEDUP_MIN_ANGLE_RAD      = 0.18   // ~10° — closer than this = same opening

// Match strength needed to link a doorway to a scene that is NOT next to it in
// the upload order. Adjacent scenes need less — capture order is itself evidence.
const MIN_SCORE_FAR      = 3
const MIN_SCORE_ADJACENT = 1

export function titleCase(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function pctToYawRad(pct: number): number {
  return (pct / 100 - 0.5) * 2 * Math.PI
}

export function oppositeYawRad(yawRad: number): number {
  const f = yawRad + Math.PI
  return f > Math.PI ? f - 2 * Math.PI : f
}

export function angularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

/** Apparent size → marker scale, so near doorways get bigger arrows than far ones. */
export function scaleFor(sizeDeg: number, kind: 'nav' | 'info'): number {
  const raw = kind === 'nav' ? sizeDeg / 40 : 0.8 + sizeDeg / 100
  const [lo, hi] = kind === 'nav' ? [0.7, 1.4] : [0.8, 1.2]
  return Math.round(Math.min(hi, Math.max(lo, raw)) * 20) / 20
}

/** Stairs read better with direction: "Up to Bedroom", "Down to Lounge". */
export function navLabel(targetLabel: string, door: Pick<PlanDoorway, 'kind'> | null): string {
  if (door?.kind === 'stairs_up')   return `Up to ${targetLabel}`
  if (door?.kind === 'stairs_down') return `Down to ${targetLabel}`
  return targetLabel
}

// Words that say nothing about which room it is.
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'room', 'area', 'space', 'scene', 'door', 'way', 'next', 'other'])

function tokens(s: string | undefined): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .map(w => w.replace(/s$/, ''))      // bedrooms → bedroom
    .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
}

/** How well a doorway's "leads_to" describes a scene. 0 = no evidence. */
export function matchScore(leadsTo: string, scene: PlanScene): number {
  const want = tokens(leadsTo)
  if (!want.length) return 0
  let best = 0
  for (const name of [scene.newName, scene.roomType, scene.name]) {
    const have = tokens(name)
    if (!have.length) continue
    if (want.join(' ') === have.join(' ')) { best = Math.max(best, 4); continue }
    const hits = want.filter(w => have.includes(w)).length
    if (hits === 0) continue
    // Every word of the doorway found in the name ("bedroom" → "Master Bedroom") = 3;
    // only the name's words found ("master bedroom" → "Bedroom") = 2; some overlap = 1.
    best = Math.max(best, hits === want.length ? 3 : hits === have.length ? 2 : 1)
  }
  return best
}

// ── Car interiors ("See interior" badges) ──────────────────────────────────
// Mirrors viewora-app shared/utils/interiorLinks.ts interiorScenes(): a scene
// link with content.link_style 'interior' opens the inside of a car. Scenes
// reached from there by ordinary arrows (front ⇄ rear seats) are inside the
// same car. Everything reachable by ordinary arrows from a badge's scene is
// the showroom floor, and the floor wins.

export type LinkRow = { scene_id: string; type: string; target_scene_id: string | null; content?: Record<string, any> | null }

export function isInteriorRow(h: LinkRow): boolean {
  return h.type === 'scene_link' && h.content?.link_style === 'interior'
}

/** sceneId → the car it is inside (the badge's target scene). Floor scenes are absent. */
export function interiorZones(rows: LinkRow[]): Map<string, string> {
  const walk = new Map<string, string[]>()
  const badges: Array<{ from: string; to: string }> = []
  for (const h of rows) {
    if (h.type !== 'scene_link' || !h.target_scene_id) continue
    if (isInteriorRow(h)) { if (h.target_scene_id !== h.scene_id) badges.push({ from: h.scene_id, to: h.target_scene_id }) }
    else walk.set(h.scene_id, [...(walk.get(h.scene_id) ?? []), h.target_scene_id])
  }
  const zones = new Map<string, string>()
  if (!badges.length) return zones

  const outside = new Set<string>()
  const queue = [...new Set(badges.map(b => b.from))]
  while (queue.length) {
    const id = queue.pop()!
    if (outside.has(id)) continue
    outside.add(id)
    for (const next of walk.get(id) ?? []) if (!outside.has(next)) queue.push(next)
  }
  for (const b of badges) {
    if (outside.has(b.to) || zones.has(b.to)) continue
    const stack = [b.to]
    while (stack.length) {
      const id = stack.pop()!
      if (outside.has(id) || zones.has(id)) continue
      zones.set(id, b.to)
      for (const next of walk.get(id) ?? []) stack.push(next)
    }
  }
  return zones
}

type Candidate = {
  fromIdx: number; toIdx: number; doorIdx: number
  score: number; confidence: number
}

/**
 * Builds navigation suggestions for every scene.
 *
 * 1. Each doorway is linked to the scene it leads to: the AI's own pick when it
 *    names one, otherwise the best name match. Far scenes need a strong match.
 * 2. Scenes next to each other in capture order that are still unlinked get the
 *    best unused doorway (or a facing guess) so the walk-through never breaks.
 * 3. Every scene ends up with at least one way in and one way out.
 */
export function planNavLinks(
  scenes:      PlanScene[],
  doorways:    Record<string, PlanDoorway[]>,
  linkedPairs: Set<string>,
  zones:       Map<string, string> = new Map(),   // interiorZones(): sceneId → car
): NavSuggestion[] {
  const label = (s: PlanScene) => titleCase(s.newName || s.roomType || s.name || 'Next Room')
  const out: NavSuggestion[] = []
  const used = new Set<string>()          // `${fromIdx}:${doorIdx}`
  const pairs = new Set(linkedPairs)      // existing + planned `${fromId}:${toId}`

  // Floor arrows never cross between the showroom floor and a car's inside
  // (that is what the "See interior" badge is for), so capture order is
  // followed separately per zone: the walkway, then each car's seats.
  const zoneOf = (i: number) => zones.get(scenes[i].id) ?? ''
  const walkPairs = zoneNeighbours(scenes, zones).map(([a, b]) => [scenes.indexOf(a), scenes.indexOf(b)] as const)
  const isAdjacent = (a: number, b: number) => walkPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

  const push = (fromIdx: number, toIdx: number, door: PlanDoorway | null, yaw: number, pitch: number, confidence: number) => {
    const a = scenes[fromIdx], b = scenes[toIdx]
    pairs.add(`${a.id}:${b.id}`)
    out.push({
      fromSceneId: a.id, fromSceneName: a.name,
      toSceneId:   b.id, toSceneName:   b.name,
      yaw:   round4(yaw),
      pitch: round4(pitch),
      label: navLabel(label(b), door),
      doorwayDescription: door?.leads_to || (toIdx > fromIdx ? `Leads to ${label(b)}` : `Back to ${label(b)}`),
      icon:  NAV_ICON,
      scale: door ? scaleFor(door.size_deg, 'nav') : 1,
      confidence_hint: confidence,
    })
  }

  // ── 1. Doorway → destination ──────────────────────────────────────────────
  const candidates: Candidate[] = []
  scenes.forEach((from, fromIdx) => {
    ;(doorways[from.id] ?? []).forEach((door, doorIdx) => {
      const mine: Candidate[] = []
      scenes.forEach((to, toIdx) => {
        if (toIdx === fromIdx || zoneOf(toIdx) !== zoneOf(fromIdx)) return
        const adjacent = isAdjacent(fromIdx, toIdx)
        let score = matchScore(door.leads_to, to)
        if (door.target === toIdx + 1) score += 3          // the AI named this scene
        if (adjacent && score > 0) score += 0.5            // tie-break towards capture order
        if (score < (adjacent ? MIN_SCORE_ADJACENT : MIN_SCORE_FAR)) return
        mine.push({ fromIdx, toIdx, doorIdx, score, confidence: door.confidence })
      })
      // "bedroom" with three bedrooms in the tour: unless one is next door or the
      // AI named it, don't guess which — the walk-through pass covers neighbours.
      const top = Math.max(0, ...mine.map(c => c.score))
      const tied = mine.filter(c => c.score === top)
      if (tied.length > 1 && !tied.some(c => isAdjacent(c.fromIdx, c.toIdx))) {
        candidates.push(...mine.filter(c => c.score < top))
      } else {
        candidates.push(...mine)
      }
    })
  })
  candidates.sort((x, y) =>
    y.score - x.score || y.confidence - x.confidence || Math.abs(x.toIdx - x.fromIdx) - Math.abs(y.toIdx - y.fromIdx))

  for (const c of candidates) {
    const key = `${c.fromIdx}:${c.doorIdx}`
    const pair = `${scenes[c.fromIdx].id}:${scenes[c.toIdx].id}`
    if (used.has(key) || pairs.has(pair)) continue
    const door = doorways[scenes[c.fromIdx].id][c.doorIdx]
    used.add(key)
    push(c.fromIdx, c.toIdx, door, pctToYawRad(door.position_pct), door.pitch_deg * DEG_TO_RAD, door.confidence)
  }

  // ── 2. Keep the capture-order walk-through intact ─────────────────────────
  const bestUnused = (fromIdx: number): { door: PlanDoorway; idx: number } | null => {
    const list = doorways[scenes[fromIdx].id] ?? []
    let pick: { door: PlanDoorway; idx: number } | null = null
    list.forEach((door, idx) => {
      if (used.has(`${fromIdx}:${idx}`)) return
      if (!pick || door.confidence > pick.door.confidence) pick = { door, idx }
    })
    return pick
  }
  const yawOf = (fromId: string, toId: string) => out.find(s => s.fromSceneId === fromId && s.toSceneId === toId)?.yaw

  for (const [a, b] of walkPairs) {
    for (const [fromIdx, toIdx] of [[a, b], [b, a]] as const) {
      if (pairs.has(`${scenes[fromIdx].id}:${scenes[toIdx].id}`)) continue
      const pick = bestUnused(fromIdx)
      if (pick) {
        used.add(`${fromIdx}:${pick.idx}`)
        // An unmatched doorway is a weaker guess than a matched one.
        push(fromIdx, toIdx, pick.door, pctToYawRad(pick.door.position_pct), pick.door.pitch_deg * DEG_TO_RAD, Math.min(pick.door.confidence, 55))
      } else {
        // No doorway seen: face back the way we came if the reverse link is known.
        const reverse = yawOf(scenes[toIdx].id, scenes[fromIdx].id)
        const yaw = freeYaw(out, scenes[fromIdx].id, reverse != null ? oppositeYawRad(reverse) : 0)
        push(fromIdx, toIdx, null, yaw, DEFAULT_PITCH_RAD, 45)
      }
    }
  }

  out.sort((a, b) => b.confidence_hint - a.confidence_hint)
  const extra = ensureFullConnectivity(scenes, out, linkedPairs, zones)
  for (const s of extra) s.yaw = round4(freeYaw([...out, ...extra.filter(e => e !== s)], s.fromSceneId, s.yaw))
  return [...out, ...extra]
}

/** A guessed arrow must not sit on top of a real one in the same scene: step it aside. */
function freeYaw(placed: NavSuggestion[], fromSceneId: string, yaw: number): number {
  const taken = placed.filter(p => p.fromSceneId === fromSceneId).map(p => p.yaw)
  for (let step = 0; step < 12; step++) {
    const offset = Math.ceil(step / 2) * 20 * DEG_TO_RAD * (step % 2 ? 1 : -1)
    let y = yaw + offset
    if (y > Math.PI) y -= 2 * Math.PI
    if (y < -Math.PI) y += 2 * Math.PI
    if (taken.every(t => angularDist(t, y) >= DEDUP_MIN_ANGLE_RAD)) return y
  }
  return yaw
}

function round4(n: number): number {
  return parseFloat(n.toFixed(4))
}

/**
 * Every scene must have at least one way out and one way in, or the tour has
 * a dead end. Adds a low-confidence link to the neighbour in capture order.
 */
/** Consecutive scenes (capture order) within the same zone: the walk-through. */
export function zoneNeighbours(scenes: PlanScene[], zones: Map<string, string>): Array<[PlanScene, PlanScene]> {
  const lists = new Map<string, PlanScene[]>()
  for (const s of scenes) {
    const z = zones.get(s.id) ?? ''
    lists.set(z, [...(lists.get(z) ?? []), s])
  }
  const out: Array<[PlanScene, PlanScene]> = []
  for (const list of lists.values()) for (let k = 0; k < list.length - 1; k++) out.push([list[k], list[k + 1]])
  return out
}

export function ensureFullConnectivity(
  scenes: PlanScene[],
  suggestions: NavSuggestion[],
  existingLinkedPairs: Set<string>,
  zones: Map<string, string> = new Map(),
): NavSuggestion[] {
  const walk = zoneNeighbours(scenes, zones)
  const extra: NavSuggestion[] = []
  const outgoing = new Map<string, Set<string>>(scenes.map(s => [s.id, new Set()]))
  const incoming = new Map<string, Set<string>>(scenes.map(s => [s.id, new Set()]))

  for (const pair of existingLinkedPairs) {
    const [from, to] = pair.split(':')
    outgoing.get(from)?.add(to)
    incoming.get(to)?.add(from)
  }
  for (const s of suggestions) {
    outgoing.get(s.fromSceneId)?.add(s.toSceneId)
    incoming.get(s.toSceneId)?.add(s.fromSceneId)
  }

  const link = (from: PlanScene, to: PlanScene, yaw: number, description: string) => {
    extra.push({
      fromSceneId: from.id, fromSceneName: from.name,
      toSceneId:   to.id,   toSceneName:   to.name,
      yaw, pitch: DEFAULT_PITCH_RAD, confidence_hint: 40,
      label: titleCase(to.newName || to.roomType || to.name || 'Next Room'),
      doorwayDescription: description, icon: NAV_ICON, scale: 1,
    })
    outgoing.get(from.id)?.add(to.id)
    incoming.get(to.id)?.add(from.id)
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    // Next/previous in the same zone; a car's only interior scene has none
    // (its way in is the badge, its way out is the viewer's "back" button).
    const neighbours = [
      ...walk.filter(([a]) => a === scene).map(([, b]) => b),
      ...walk.filter(([, b]) => b === scene).map(([a]) => a),
    ]
    if (!neighbours.length) continue

    if ((outgoing.get(scene.id)?.size ?? 0) === 0) {
      const target = neighbours[0]
      if (!existingLinkedPairs.has(`${scene.id}:${target.id}`)) link(scene, target, 0, 'Continue tour')
    }
    if ((incoming.get(scene.id)?.size ?? 0) === 0) {
      const source = neighbours.find(c => !outgoing.get(c.id)?.has(scene.id)) ?? neighbours[0]
      if (!existingLinkedPairs.has(`${source.id}:${scene.id}`)) link(source, scene, Math.PI, 'Return')
    }
  }
  return extra
}
