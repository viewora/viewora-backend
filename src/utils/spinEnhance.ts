// Studio finish for a car spin: one colour grade for the whole lap, so every frame matches.
//
// Phone and action-camera walk-arounds are flat (a dim car park, lifted blacks), lean warm or green
// under strip lights, and the camera re-exposes as you walk, so some frames are brighter than
// others and the spin flickers. Fixing each frame on its own would make that worse. Instead:
//   1. read every frame small and measure it (frameStats)
//   2. plan one grade for the lap: black point, white balance, contrast, and a per-frame exposure
//      nudge that follows the lap's smoothed brightness (planSpinGrade)
//   3. apply it as a lookup table plus vibrance (applyGrade), then sharpen and save (enhanceFrame).
// The original files are never changed: the finished copy is saved next to each one.

import sharp from 'sharp'

export type SpinLook = 'natural' | 'vivid' | 'hd'
export const SPIN_LOOKS: SpinLook[] = ['natural', 'vivid', 'hd']

/** Bumped when the grade changes, so new copies never collide with old cached ones. */
export const ENHANCE_VERSION = 1

interface LookSettings {
  /** S-curve strength (0 none). */
  contrast: number
  /** Midtone lift: below 1 brightens shadows and dark paint. */
  gamma: number
  /** Extra saturation for muted colours, less for already strong ones (0 none). */
  vibrance: number
  /** How far to pull the lap's grey towards neutral (0..1). */
  whiteBalance: number
  /**
   * Unsharp mask for edges, badges, wheels. Flat areas (m1) are left alone: video frames carry
   * compression noise, and sharpening it shows as speckle on smooth paint. x1 is the edge threshold.
   */
  sharpen: { sigma: number; m1: number; m2: number; x1: number }
  /** Large-radius local contrast ("clarity"): lifts the haze off the paint (0 none). */
  clarity: number
  /** Lifts dark areas (dark paint, tyres, the car's shaded side) by up to this share (0 none). */
  shadows: number
  /** Holds back bright areas (windows behind the car, white paint in sun) (0 none). */
  highlights: number
}

export const LOOKS: Record<SpinLook, LookSettings> = {
  natural: {
    contrast: 0.35, gamma: 0.94, vibrance: 0.22, whiteBalance: 0.6,
    sharpen: { sigma: 0.9, m1: 0, m2: 2.2, x1: 9 },
    clarity: 0.35, shadows: 0.55, highlights: 0.35,
  },
  // AI HD: the frame is first restored by an AI model (Real-ESRGAN, see aiRestore.ts), which already
  // gives clean edges, so no clarity or sharpening on top (that is what made frames look over-done).
  hd: {
    contrast: 0.3, gamma: 0.95, vibrance: 0.18, whiteBalance: 0.6,
    sharpen: { sigma: 0.5, m1: 0, m2: 0, x1: 9 },
    clarity: 0, shadows: 0.45, highlights: 0.3,
  },
  vivid: {
    contrast: 0.55, gamma: 0.88, vibrance: 0.38, whiteBalance: 0.75,
    sharpen: { sigma: 1, m1: 0, m2: 2.8, x1: 9 },
    clarity: 0.6, shadows: 0.8, highlights: 0.5,
  },
}

/** Measurements of one frame, from a small copy. */
export interface FrameStats {
  /** Mean luma (0..255). */
  mean: number
  /** Luma at the 0.5th and 99.5th percentiles. */
  low: number
  high: number
  /** Average R, G, B of near-grey midtone pixels (for white balance), or null when there are too few. */
  grey: [number, number, number] | null
}

/** One frame's part of the plan. */
export interface FrameGrade {
  /** Per-channel lookup tables (256 entries each). */
  lut: [Uint8Array, Uint8Array, Uint8Array]
  vibrance: number
}

export interface SpinPlan {
  look: SpinLook
  black: number
  white: number
  wb: [number, number, number]
  /** Exposure gain per frame, in frame order. */
  gains: number[]
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Measures interleaved RGB(A) pixels. */
export function frameStats(px: Uint8Array | Buffer, channels: number): FrameStats {
  const hist = new Uint32Array(256)
  let sum = 0
  let n = 0
  const grey = [0, 0, 0]
  let greyN = 0
  for (let i = 0; i + 2 < px.length; i += channels) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const y = luma(r, g, b)
    hist[Math.round(y)]++
    sum += y
    n++
    // Near-grey midtones: concrete, ceilings, pillars. Clipped and coloured pixels say nothing about the light.
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (y > 50 && y < 220 && mx - mn < 0.22 * mx) { grey[0] += r; grey[1] += g; grey[2] += b; greyN++ }
  }
  const pct = (p: number) => {
    const target = p * n
    let acc = 0
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v }
    return 255
  }
  return {
    mean: n ? sum / n : 128,
    low: pct(0.005),
    high: pct(0.995),
    grey: greyN > n * 0.02 ? [grey[0] / greyN, grey[1] / greyN, grey[2] / greyN] : null,
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Brightness of each frame smoothed around the lap (it wraps: the last frame sits next to the first).
 * Slow changes (the sunny side of the car) stay; jumps between neighbouring frames go.
 */
export function smoothLap(values: number[], radius: number): number[] {
  const n = values.length
  if (n < 3) return [...values]
  const r = Math.min(radius, Math.floor((n - 1) / 2))
  return values.map((_, i) => {
    let s = 0
    for (let k = -r; k <= r; k++) s += values[(((i + k) % n) + n) % n]
    return s / (2 * r + 1)
  })
}

/** One grade for the whole lap. `stats` is in walk-around order. */
export function planSpinGrade(stats: FrameStats[], look: SpinLook): SpinPlan {
  const set = LOOKS[look]
  // Black point from the lap, not each frame: lift the haze, but never crush a frame that is darker.
  const black = clamp(median(stats.map(s => s.low)) * 0.8, 0, 40)
  // White point: most frames hit 255 through the windows; only stretch when the lap never does.
  const white = clamp(median(stats.map(s => s.high)), 200, 255)

  // White balance: pull the lap's average grey part of the way to neutral, at most 12% a channel.
  const greys = stats.map(s => s.grey).filter((g): g is [number, number, number] => !!g)
  let wb: [number, number, number] = [1, 1, 1]
  if (greys.length >= Math.max(1, stats.length / 4)) {
    const avg = [0, 1, 2].map(c => median(greys.map(g => g[c])))
    const target = (avg[0] + avg[1] + avg[2]) / 3
    wb = avg.map(a => clamp(1 + (target / Math.max(1, a) - 1) * set.whiteBalance, 0.88, 1.12)) as [number, number, number]
  }

  // Exposure: each frame towards the smoothed lap, within ±15%.
  const means = stats.map(s => s.mean)
  const smooth = smoothLap(means, 4)
  const gains = means.map((m, i) => clamp(smooth[i] / Math.max(1, m), 0.87, 1.15))
  return { look, black, white, wb, gains }
}

/**
 * Contrast curve on 0..1 that keeps 0, 0.5 and 1 in place. Dark tones get only a light touch: dark
 * paint already sits there, and a full S-curve turns a navy or black car into a silhouette.
 */
export function sCurve(x: number, strength: number): number {
  const k = 1 + strength * 1.6
  const s = x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k)
  const amount = Math.min(1, strength * 1.4) * (x < 0.5 ? 0.3 : 1)
  return x + (s - x) * amount
}

/** The lookup tables for frame i of the plan. */
export function frameGrade(plan: SpinPlan, i: number): FrameGrade {
  const set = LOOKS[plan.look]
  const gain = plan.gains[i] ?? 1
  const span = Math.max(1, plan.white - plan.black)
  const lut = [0, 1, 2].map(c => {
    const t = new Uint8Array(256)
    for (let v = 0; v < 256; v++) {
      let x = (v * plan.wb[c] * gain - plan.black) / span
      x = clamp(x, 0, 1)
      x = Math.pow(x, set.gamma)
      x = sCurve(x, set.contrast)
      t[v] = Math.round(clamp(x, 0, 1) * 255)
    }
    return t
  }) as [Uint8Array, Uint8Array, Uint8Array]
  return { lut, vibrance: set.vibrance }
}

/** Applies the tables and vibrance to interleaved RGB(A) pixels, in place. */
export function applyGrade(px: Uint8Array | Buffer, channels: number, g: FrameGrade): void {
  const [lr, lg, lb] = g.lut
  const vib = g.vibrance
  for (let i = 0; i + 2 < px.length; i += channels) {
    let r = lr[px[i]], gg = lg[px[i + 1]], b = lb[px[i + 2]]
    if (vib > 0) {
      const mx = Math.max(r, gg, b)
      const mn = Math.min(r, gg, b)
      const sat = mx ? (mx - mn) / mx : 0
      // Muted colours gain the most, strong ones little. Near-greys (white, silver, black paint,
      // concrete) are left alone: their only "colour" is video noise, and boosting it shows as speckle.
      const neutral = sat < 0.1 ? 0 : sat < 0.22 ? (sat - 0.1) / 0.12 : 1
      const lift = vib * (1 - sat) * neutral
      if (lift > 0.001) {
        const avg = (r + gg + b) / 3
        r = avg + (r - avg) * (1 + lift)
        gg = avg + (gg - avg) * (1 + lift)
        b = avg + (b - avg) * (1 + lift)
      }
    }
    px[i] = r < 0 ? 0 : r > 255 ? 255 : r
    px[i + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg
    px[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
  }
}

/** Long edge of the small copy measured per frame. */
const STATS_EDGE = 320

/** Measures one frame (any image file). */
export async function measureFrame(file: Buffer): Promise<FrameStats> {
  const { data, info } = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize(STATS_EDGE, STATS_EDGE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return frameStats(data, info.channels)
}

export interface LocalTone { clarity: number; shadows: number; highlights: number }

/** Bilinear sample of a small single-channel image at full-size pixel (x, y). */
function sampler(src: Uint8Array | Buffer, bw: number, bh: number, width: number, height: number) {
  const sx = bw / width, sy = bh / height
  return (x: number, y: number) => {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0
    const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
    const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0
    const a = src[y0 * bw + x0], b = src[y0 * bw + x1], c = src[y1 * bw + x0], d = src[y1 * bw + x1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
}

/**
 * Local tone, the showroom look. Uses two blurred copies of the brightness:
 *  - clarity pushes the fine-but-not-pixel detail (the small unblurred copy) away from its near surroundings,
 *    strongest in the midtones. It never looks at single pixels, so it lifts haze without lifting video grain;
 *  - shadows lifts areas whose wider surroundings are dark (dark paint, the shaded side, tyres);
 *  - highlights holds back areas whose surroundings are bright (windows behind the car).
 * Brightness changes only: each pixel's R, G, B are scaled together, so colours keep their hue.
 */
export function applyLocalTone(
  px: Uint8Array | Buffer, channels: number, width: number, height: number,
  detail: { data: Uint8Array | Buffer; w: number; h: number },
  near: { data: Uint8Array | Buffer; w: number; h: number },
  wide: { data: Uint8Array | Buffer; w: number; h: number },
  t: LocalTone,
): void {
  const detailAt = sampler(detail.data, detail.w, detail.h, width, height)
  const nearAt = sampler(near.data, near.w, near.h, width, height)
  const wideAt = sampler(wide.data, wide.w, wide.h, width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const r = px[i], g = px[i + 1], bl = px[i + 2]
      const yy = luma(r, g, bl)
      if (yy < 0.5) continue
      let target = yy
      if (t.clarity > 0) {
        const mid = 1 - Math.abs(yy - 128) / 128 // 1 at mid grey, 0 at black or white
        target += t.clarity * mid * (detailAt(x, y) - nearAt(x, y))
      }
      const yw = wideAt(x, y)
      if (t.shadows > 0 && yw < 130) {
        // Linear in how dark the surroundings are, and fading out as the pixel itself gets bright,
        // so dark paint opens up while reflections on it stay as they are.
        const d = (130 - yw) / 130
        target *= 1 + t.shadows * 1.6 * d * (1 - yy / 255)
      }
      if (t.highlights > 0 && yw > 170) {
        const d = (yw - 170) / 85
        target -= t.highlights * d * d * Math.max(0, target - 150) * 0.6
      }
      const k = target / yy
      const nr = r * k, ng = g * k, nb = bl * k
      px[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr
      px[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng
      px[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb
    }
  }
}

/** AI restoration of one frame (returns an image of any size; it is scaled back to the frame's size). */
export type RestoreFn = (jpeg: Buffer) => Promise<Buffer>

/** The finished copy of one frame: (AI restored,) graded, clarity, sharpened, saved as a crisp JPEG. */
export async function enhanceFrame(file: Buffer, grade: FrameGrade, look: SpinLook, restore?: RestoreFn): Promise<{ buffer: Buffer; width: number; height: number }> {
  const set = LOOKS[look]
  let src = file
  if (look === 'hd') {
    if (!restore) throw new Error('the worker has no REPLICATE_API_TOKEN: add it to the worker service in Railway')
    const meta = await sharp(file, { failOn: 'none' }).rotate().metadata()
    const W = meta.autoOrient?.width ?? meta.width ?? 0, H = meta.autoOrient?.height ?? meta.height ?? 0
    // The model works on a 1280-wide copy and doubles it; the result is scaled back to the frame's own
    // size, so files stay the same size and the restored detail is packed into every pixel.
    const input = await sharp(file, { failOn: 'none' }).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer()
    const restored = await restore(input)
    src = await sharp(restored).resize(W || undefined, H || undefined, { fit: 'fill', kernel: 'lanczos3' }).png({ compressionLevel: 1 }).toBuffer()
  }
  const { data, info } = await sharp(src, { failOn: 'none' })
    .rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  applyGrade(data, info.channels, grade)
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } } as const
  if (set.clarity > 0 || set.shadows > 0 || set.highlights > 0) {
    const w = Math.max(8, Math.round(info.width / 8)), h = Math.max(8, Math.round(info.height / 8))
    const small = await sharp(data, raw).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer()
    // extractChannel: sharp hands a blurred one-channel image back as three channels.
    const blurred = (sigma: number) => sharp(small, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer()
    const [near, wide] = await Promise.all([blurred(Math.max(1, w / 25)), blurred(Math.max(1, w / 10))])
    applyLocalTone(data, info.channels, info.width, info.height, { data: small, w, h }, { data: near, w, h }, { data: wide, w, h }, set)
  }
  let out = sharp(data, raw)
  if (set.sharpen.m2 > 0) out = out.sharpen(set.sharpen)
  const buffer = await out
    // 4:4:4 keeps colour edges clean (red tail lights, badges); mozjpeg keeps the file small.
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4', progressive: true })
    .toBuffer()
  return { buffer, width: info.width, height: info.height }
}
