import type { FastifyInstance } from 'fastify'

// A car's dashboard card shows the car from the front: the frame of its first spin nearest
// the spin's start angle. Its interior 360s and close-ups come after.

type Spin = { id: string; space_id: string; start_angle: number | null; order_index: number | null }
type Frame = { spin_id: string; image_url: string | null; angle: number | null }

/** Shortest distance between two angles, in degrees. */
function gap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(d, 360 - d)
}

/** Each space's first spin (lowest order_index). */
export function firstSpins(spins: Spin[]): Map<string, Spin> {
  const out = new Map<string, Spin>()
  for (const s of [...spins].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))) {
    if (!out.has(s.space_id)) out.set(s.space_id, s)
  }
  return out
}

/** Space id -> front frame URL, from the spaces' spins and those spins' frames. */
export function pickCarCovers(spins: Spin[], frames: Frame[]): Map<string, string> {
  const bySpin = new Map<string, Frame[]>()
  for (const f of frames) {
    if (!f.image_url) continue
    const list = bySpin.get(f.spin_id) ?? []
    list.push(f)
    bySpin.set(f.spin_id, list)
  }
  const out = new Map<string, string>()
  for (const [spaceId, spin] of firstSpins(spins)) {
    const start = Number(spin.start_angle ?? 0)
    const best = (bySpin.get(spin.id) ?? [])
      .sort((a, b) => gap(Number(a.angle ?? 0), start) - gap(Number(b.angle ?? 0), start))[0]
    if (best?.image_url) out.set(spaceId, best.image_url)
  }
  return out
}

const SPINS_PER_QUERY = 12   // up to ~64 frames each: stays under the 1000-row response cap

/** Front frames for these car spaces. A failed lookup only leaves cards on their old picture. */
export async function carCovers(fastify: FastifyInstance, spaceIds: string[]): Promise<Map<string, string>> {
  if (!spaceIds.length) return new Map()
  try {
    const { data, error } = await fastify.supabase
      .from('vehicle_spins').select('id, space_id, start_angle, order_index').in('space_id', spaceIds)
    if (error || !data?.length) return new Map()
    const spins = data as Spin[]
    const spinIds = [...firstSpins(spins).values()].map(s => s.id)
    const frames: Frame[] = []
    for (let i = 0; i < spinIds.length; i += SPINS_PER_QUERY) {
      const { data: rows } = await fastify.supabase
        .from('vehicle_views').select('spin_id, image_url, angle').in('spin_id', spinIds.slice(i, i + SPINS_PER_QUERY))
      if (rows) frames.push(...(rows as Frame[]))
    }
    return pickCarCovers(spins, frames)
  } catch (err) {
    fastify.log.warn({ err }, 'Car cover lookup failed')
    return new Map()
  }
}
