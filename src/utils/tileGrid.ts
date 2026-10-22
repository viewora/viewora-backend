// Full-res tile grid rule, shared by tile-processor (which cuts the tiles) and
// retile (which finds scenes cut under the old rule) so the two can't drift.

export const TILE_SIZE = 512

function prevPowerOfTwo(n: number): number {
  if (n < 2) return 1
  return Math.pow(2, Math.floor(Math.log2(n)))
}

/**
 * PSV EquirectangularTilesAdapter requires cols and rows to be powers of 2.
 * Full-res tiles use the largest power-of-2 grid whose tiles are still at
 * least TILE_SIZE (16×8 of ~744px for a 12K panorama, 8×4 of ~720px for 5.7K).
 * The old rule snapped up instead, giving tiles of ~360–372px — 2–20 KB each,
 * so loading a zoomed-in view was bound by round trips, not bandwidth.
 */
export function fullResGrid(width: number, height: number): { cols: number; rows: number } {
  return {
    cols: prevPowerOfTwo(Math.floor(width / TILE_SIZE)),
    rows: prevPowerOfTwo(Math.floor(height / TILE_SIZE)),
  }
}
