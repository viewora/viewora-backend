/**
 * Automated floor-plan generator — two-tier architecture:
 *
 * Tier 1 (always runs): computes scene positions via BFS through scene_link hotspots,
 *   estimates room shape from hotspot angular distribution, renders an SVG floor plan.
 *
 * Tier 2 (when available): if a scene has room_layout_json set (filled by an external
 *   HorizonNet service via POST /internal/scenes/:id/room-layout), the generator uses
 *   the actual room polygon instead of the Tier-1 estimate for that room. The rest of
 *   the pipeline (positions, SVG upload, cache bust) is identical — the same function
 *   handles both tiers transparently.
 *
 * Triggering: called from the BullMQ worker after all scenes in a space finish tiling.
 * Re-triggered: each time a room_layout_json is stored for a scene.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// ── Canvas / layout constants ─────────────────────────────────────────────
const CANVAS_W = 1100
const CANVAS_H = 780
const MARGIN   = 80       // min px from canvas edge to any room centre

/** Distance between adjacent scene centres in virtual-px (before normalisation). */
const STEP = 240

/** Half-dimension of a room rect (virtual-px) — bounded by these limits. */
const ROOM_MIN = 62
const ROOM_MAX = 108

// ── Types ─────────────────────────────────────────────────────────────────
interface Pos { x: number; y: number }

export interface SceneRow {
  id: string
  name: string
  order_index: number
  /** Tier-2 polygon from HorizonNet. Coordinates in "room units" (see note below). */
  room_layout_json: Pos[] | null
}

export interface HotspotRow {
  scene_id: string
  type: string
  /** Yaw stored in radians — comes directly from PSV internal coordinates. */
  yaw: number
  target_scene_id: string | null
}

// ── 1. BFS position layout ─────────────────────────────────────────────────
/**
 * Assigns each scene a 2D virtual position using a BFS traversal of scene_link
 * hotspots. The yaw angle of each link is the compass bearing from the source
 * scene to the target scene in a top-down view.
 *
 * Scenes not reachable via hotspots (isolated or orphaned) are placed below the
 * main cluster so they still appear on the floor plan.
 */
export function computeScenePositions(
  scenes: Pick<SceneRow, 'id' | 'order_index'>[],
  hotspots: HotspotRow[],
): Map<string, Pos> {
  const positions = new Map<string, Pos>()
  if (!scenes.length) return positions

  const sorted = [...scenes].sort((a, b) => a.order_index - b.order_index)
  positions.set(sorted[0].id, { x: 0, y: 0 })

  // Index hotspots by scene
  const byScene = new Map<string, HotspotRow[]>()
  for (const h of hotspots) {
    if (!byScene.has(h.scene_id)) byScene.set(h.scene_id, [])
    byScene.get(h.scene_id)!.push(h)
  }

  const visited = new Set([sorted[0].id])
  const queue: string[] = [sorted[0].id]

  while (queue.length) {
    const id = queue.shift()!
    const pos = positions.get(id)!

    const links = (byScene.get(id) ?? []).filter(
      h => h.type === 'scene_link' && h.target_scene_id && !visited.has(h.target_scene_id!),
    )

    for (const link of links) {
      const tid = link.target_scene_id!
      // PSV yaw 0 = north, +π/2 = east.
      // SVG y-axis increases downward so north = -y.
      positions.set(tid, {
        x: pos.x + Math.sin(link.yaw) * STEP,
        y: pos.y - Math.cos(link.yaw) * STEP,
      })
      visited.add(tid)
      queue.push(tid)
    }
  }

  // Place unreachable scenes in a row below the main cluster
  const unreachable = sorted.filter(s => !visited.has(s.id))
  if (unreachable.length) {
    const maxY = Math.max(...Array.from(positions.values()).map(p => p.y), 0)
    unreachable.forEach((s, i) => {
      const spread = (i - (unreachable.length - 1) / 2) * STEP
      positions.set(s.id, { x: spread, y: maxY + STEP })
    })
  }

  return positions
}

// ── 2. Room dimensions — Tier 1 estimate or Tier 2 polygon ────────────────
/**
 * Returns the half-width and half-height of the room rectangle in virtual-px.
 *
 * Tier 2 path: if room_layout_json is set, the polygon bounding box is used.
 *   Polygon coordinates are expected in "room units" where 1 unit ≈ STEP/4 virtual-px
 *   (i.e. roughly metres if the room is ~10m across and STEP ≈ 240px). The Python
 *   HorizonNet service is responsible for outputting coordinates in this scale.
 *
 * Tier 1 path: uses the angular distribution of navigation hotspots.
 *   Hotspots spread mostly N-S → tall room; spread mostly E-W → wide room.
 */
function roomDims(
  sceneId: string,
  hotspots: HotspotRow[],
  roomLayout: Pos[] | null,
): { halfW: number; halfH: number; fromAI: boolean } {

  if (roomLayout && roomLayout.length >= 3) {
    // Tier 2: scale polygon bounding box to virtual-px
    const xs = roomLayout.map(p => p.x)
    const ys = roomLayout.map(p => p.y)
    const scale = STEP / 4
    return {
      halfW: clamp((Math.max(...xs) - Math.min(...xs)) / 2 * scale, ROOM_MIN, ROOM_MAX),
      halfH: clamp((Math.max(...ys) - Math.min(...ys)) / 2 * scale, ROOM_MIN, ROOM_MAX),
      fromAI: true,
    }
  }

  // Tier 1: angular analysis
  const navAngles = hotspots
    .filter(h => h.scene_id === sceneId && h.type === 'scene_link')
    .map(h => h.yaw)

  if (!navAngles.length) return { halfW: ROOM_MIN, halfH: ROOM_MIN, fromAI: false }

  const ewBias = navAngles.reduce((s, a) => s + Math.abs(Math.sin(a)), 0) / navAngles.length
  const nsBias = navAngles.reduce((s, a) => s + Math.abs(Math.cos(a)), 0) / navAngles.length

  return {
    halfW: clamp(ROOM_MIN + ewBias * (ROOM_MAX - ROOM_MIN), ROOM_MIN, ROOM_MAX),
    halfH: clamp(ROOM_MIN + nsBias * (ROOM_MAX - ROOM_MIN), ROOM_MIN, ROOM_MAX),
    fromAI: false,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ── 3. Normalise virtual positions onto the canvas ────────────────────────
export function normalise(
  rawPositions: Map<string, Pos>,
): { normed: Map<string, Pos>; scale: number } {
  if (!rawPositions.size) return { normed: new Map(), scale: 1 }

  const allX = Array.from(rawPositions.values()).map(p => p.x)
  const allY = Array.from(rawPositions.values()).map(p => p.y)
  const [minX, maxX] = [Math.min(...allX), Math.max(...allX)]
  const [minY, maxY] = [Math.min(...allY), Math.max(...allY)]

  const usableW = CANVAS_W - MARGIN * 2
  const usableH = CANVAS_H - MARGIN * 2
  const rangeX  = maxX - minX || 1
  const rangeY  = maxY - minY || 1
  const scale   = Math.min(usableW / rangeX, usableH / rangeY, 1)  // never upscale

  const offsetX = MARGIN + (usableW - rangeX * scale) / 2 - minX * scale
  const offsetY = MARGIN + (usableH - rangeY * scale) / 2 - minY * scale

  const normed = new Map<string, Pos>()
  for (const [id, p] of rawPositions) {
    normed.set(id, { x: p.x * scale + offsetX, y: p.y * scale + offsetY })
  }
  return { normed, scale }
}

// ── 4. SVG generation ─────────────────────────────────────────────────────
export function generateFloorPlanSvg(
  scenes: SceneRow[],
  hotspots: HotspotRow[],
  rawPositions: Map<string, Pos>,
): string {
  const { normed, scale } = normalise(rawPositions)

  // Room info
  interface Room {
    id: string; label: string; pos: Pos
    halfW: number; halfH: number; fromAI: boolean
  }
  const rooms: Room[] = scenes
    .filter(s => normed.has(s.id))
    .map(s => {
      const pos  = normed.get(s.id)!
      const dims = roomDims(s.id, hotspots, s.room_layout_json)
      return { id: s.id, label: s.name || `Scene ${s.order_index + 1}`, pos, ...dims }
    })

  // Connection edges (deduplicated)
  const seen = new Set<string>()
  const edges: Pos[][] = []
  for (const h of hotspots) {
    if (h.type !== 'scene_link' || !h.target_scene_id) continue
    const a = normed.get(h.scene_id)
    const b = normed.get(h.target_scene_id)
    if (!a || !b) continue
    const key = [h.scene_id, h.target_scene_id].sort().join('|')
    if (!seen.has(key)) { seen.add(key); edges.push([a, b]) }
  }

  const hasAI    = rooms.some(r => r.fromAI)
  const tierNote = hasAI
    ? 'room outlines from AI analysis · positions from hotspot graph'
    : 'positions and room sizes estimated from hotspot graph'

  const edgeSvg = edges.map(([a, b]) =>
    `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"/>`
  ).join('\n    ')

  const roomsSvg = rooms.map(room => {
    const rw = f(room.halfW * scale)
    const rh = f(room.halfH * scale)
    const fill   = room.fromAI ? '#d9e8f7' : '#e6eef7'
    const stroke = room.fromAI ? '#6fa8d4' : '#93adc8'
    return `
  <g transform="translate(${f(room.pos.x)},${f(room.pos.y)})">
    <rect x="${f(-room.halfW * scale)}" y="${f(-room.halfH * scale)}"
          width="${f(room.halfW * scale * 2)}" height="${f(room.halfH * scale * 2)}"
          rx="10" ry="10" fill="${fill}" stroke="${stroke}" stroke-width="2"
          filter="url(#shadow)"/>
    <circle cx="0" cy="0" r="7" fill="#6366f1" stroke="#fff" stroke-width="2.5"/>
    <text x="0" y="${f(room.halfH * scale + 17)}"
          text-anchor="middle"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
          font-size="11" font-weight="600" fill="#374151"
          paint-order="stroke" stroke="#f7f8fa" stroke-width="3">${x(room.label)}</text>
  </g>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
      <path d="M 44 0 L 0 0 0 44" fill="none" stroke="#eaedf2" stroke-width="0.8"/>
    </pattern>
    <filter id="shadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="rgba(0,0,0,0.09)"/>
    </filter>
  </defs>

  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#f7f8fb"/>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#grid)"/>

  <!-- Connection lines -->
  <g stroke="#b4c5d8" stroke-width="2" stroke-dasharray="9 5" stroke-linecap="round" fill="none">
    ${edgeSvg}
  </g>

  <!-- Rooms -->
  ${roomsSvg}

  <!-- Compass rose -->
  <g transform="translate(${CANVAS_W - 56},56)">
    <circle cx="0" cy="0" r="28" fill="rgba(255,255,255,0.9)" stroke="#d1d8e5" stroke-width="1.5"/>
    <path d="M0,-20 L5,-5 L0,-11 L-5,-5 Z" fill="#374151"/>
    <path d="M0,20 L5,5 L0,11 L-5,5 Z" fill="#c0c9d6"/>
    <text x="0" y="-6.5" text-anchor="middle"
          font-family="-apple-system,sans-serif" font-size="10" font-weight="700" fill="#374151">N</text>
  </g>

  <!-- Legend -->
  <g transform="translate(${MARGIN},${CANVAS_H - 22})">
    <circle cx="0" cy="-3" r="5" fill="#6366f1"/>
    <text x="13" y="0" font-family="-apple-system,sans-serif" font-size="9" fill="#6b7280">Scene position</text>
    <text x="${CANVAS_W - MARGIN * 2 - 8}" y="0" text-anchor="end"
          font-family="-apple-system,sans-serif" font-size="9" fill="#9ca3af">
      Generated by Viewora · ${x(tierNote)}
    </text>
  </g>
</svg>`
}

/** Round to 1 decimal place for SVG coordinates. */
function f(n: number): string { return n.toFixed(1) }
/** XML-escape a string for SVG text content. */
function x(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── 5. Full pipeline: generate, upload, persist ───────────────────────────
/**
 * Main entry point called by the worker.
 * 1. Fetches all scenes + hotspots for the space.
 * 2. Computes scene positions via BFS.
 * 3. Generates SVG (Tier 1 estimates, upgraded to Tier 2 per-room when available).
 * 4. Uploads SVG to R2.
 * 5. Persists floorplan_url on the space + updates position_x/y on each scene.
 * 6. Busts Redis cache.
 *
 * Returns the public URL of the generated floor plan, or null on failure.
 */
export async function generateSpaceFloorPlan(
  s3: S3Client,
  supabase: any,
  spaceId: string,
  cdnBase: string,
  redis?: { del: (key: string) => Promise<any> } | null,
): Promise<string | null> {
  console.log(`[FLOOR-PLAN] Starting generation for space ${spaceId}`)

  // Fetch scenes
  const { data: scenes, error: scenesErr } = await supabase
    .from('scenes')
    .select('id, name, order_index, room_layout_json')
    .eq('space_id', spaceId)
    .order('order_index', { ascending: true })

  if (scenesErr) {
    console.error(`[FLOOR-PLAN] Failed to fetch scenes: ${scenesErr.message}`)
    return null
  }
  if (!scenes?.length) {
    console.warn(`[FLOOR-PLAN] No scenes for space ${spaceId} — skipping`)
    return null
  }

  // Fetch hotspots for all scenes in this space
  const sceneIds: string[] = scenes.map((s: any) => s.id)
  const { data: hotspots } = await supabase
    .from('hotspots')
    .select('scene_id, type, yaw, target_scene_id')
    .in('scene_id', sceneIds)

  const hs: HotspotRow[] = hotspots ?? []

  // Compute positions and normalise to canvas pixels in one pass.
  // We save the CANVAS positions (not virtual coords) so that MapPlugin's
  // `center` config receives pixel coordinates that actually match the SVG image.
  const rawPositions = computeScenePositions(scenes as SceneRow[], hs)
  const { normed: canvasPositions } = normalise(rawPositions)

  // Generate SVG — passes rawPositions; normalise() is called internally too,
  // but that's a pure computation so the double call is harmless.
  const svg = generateFloorPlanSvg(scenes as SceneRow[], hs, rawPositions)

  // Upload SVG to R2
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) {
    console.error('[FLOOR-PLAN] R2_BUCKET_NAME not set')
    return null
  }

  const key = `spaces/${spaceId}/floorplan/auto-generated.svg`
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(svg, 'utf-8'),
      ContentType: 'image/svg+xml',
      CacheControl: 'public, max-age=3600, stale-while-revalidate=86400',
    }))
  } catch (err: any) {
    console.error(`[FLOOR-PLAN] R2 upload failed: ${err.message}`)
    return null
  }

  const publicUrl = `${cdnBase}/${key}`

  // Save canvas pixel positions — these are what MapPlugin uses for `center`
  // to know where on the SVG image each scene dot sits.
  const positionUpdates = Array.from(canvasPositions.entries()).map(([id, pos]) =>
    supabase.from('scenes')
      .update({ position_x: pos.x, position_y: pos.y })
      .eq('id', id)
  )

  await Promise.all([
    supabase.from('properties').update({ floorplan_url: publicUrl }).eq('id', spaceId),
    ...positionUpdates,
  ])

  // Bust Redis tour cache
  if (redis) {
    const { data: space } = await supabase
      .from('properties').select('slug').eq('id', spaceId).single()
    if (space?.slug) {
      await redis.del(`tour:${space.slug}`).catch(() => {})
    }
  }

  const aiCount = (scenes as SceneRow[]).filter(s => s.room_layout_json).length
  const tierLabel = aiCount > 0
    ? `Tier 2 (${aiCount} AI rooms) + Tier 1 (${scenes.length - aiCount} estimated)`
    : `Tier 1 (all ${scenes.length} rooms estimated)`
  console.log(`[FLOOR-PLAN] Done for space ${spaceId}: ${tierLabel} → ${publicUrl}`)

  return publicUrl
}
