import sharp from 'sharp'

// Renders flat perspective views from an equirectangular panorama so vision
// models see undistorted geometry, and maps points in those views back to
// panorama yaw/pitch.
//
// Angle convention (matches hotspots table + autolink pctToYawRad):
//   yaw   ∈ [-π, π]  — 0 = panorama centre, positive = to the right
//   pitch ∈ [-π/2, π/2] — 0 = horizon, positive = up

export const VIEW_SIZE    = 768
export const VIEW_FOV_DEG = 90
// 6 level views, 60° apart → each adjacent pair overlaps by 30°, so a doorway
// cut by one view's edge is whole in its neighbour.
export const VIEW_YAWS_DEG = [0, 60, 120, 180, 240, 300]

const DEG_TO_RAD = Math.PI / 180

/** A pinhole camera looking out from the panorama centre. */
export type ViewSpec = {
  yaw:    number   // radians, where the view is centred
  pitch:  number   // radians
  fovDeg: number   // horizontal = vertical (square views)
  size:   number   // output pixels per side
}

export type PanoView = {
  index:    number   // 0-based
  yawRad:   number
  jpegB64:  string
}

/** Equirect pixels, possibly only a horizontal/vertical slice of the full panorama. */
export type EquirectSource = {
  data:     Buffer
  width:    number    // of this buffer
  height:   number
  channels: number
  fullW:    number    // of the whole panorama
  fullH:    number
  x0:       number    // where this buffer starts in the whole panorama
  y0:       number
}

export function wrapYaw(a: number): number {
  let r = a % (2 * Math.PI)
  if (r >  Math.PI) r -= 2 * Math.PI
  if (r < -Math.PI) r += 2 * Math.PI
  return r
}

function focal(spec: ViewSpec): number {
  return (spec.size / 2) / Math.tan((spec.fovDeg / 2) * DEG_TO_RAD)
}

/** Pixel (u, v) in a view → panorama yaw/pitch. */
export function viewPixelToSpherical(spec: ViewSpec, u: number, v: number): { yaw: number; pitch: number } {
  const f  = focal(spec)
  const x  = (u - spec.size / 2) / f
  const y  = (spec.size / 2 - v) / f
  const cp = Math.cos(spec.pitch), sp = Math.sin(spec.pitch)
  const y2 = y * cp + sp
  const z2 = -y * sp + cp
  return {
    yaw:   wrapYaw(spec.yaw + Math.atan2(x, z2)),
    pitch: Math.atan2(y2, Math.hypot(x, z2)),
  }
}

/** Panorama yaw/pitch → pixel (u, v) in a view, or null if behind the camera. */
export function sphericalToViewPixel(spec: ViewSpec, yaw: number, pitch: number): { u: number; v: number } | null {
  const dy = wrapYaw(yaw - spec.yaw)
  const X  = Math.cos(pitch) * Math.sin(dy)
  const Y  = Math.sin(pitch)
  const Z  = Math.cos(pitch) * Math.cos(dy)
  const cp = Math.cos(spec.pitch), sp = Math.sin(spec.pitch)
  const y  = Y * cp - Z * sp
  const z  = Y * sp + Z * cp
  if (z <= 1e-6) return null
  const f = focal(spec)
  return { u: spec.size / 2 + f * X / z, v: spec.size / 2 - f * y / z }
}

// ── Fixed 6-view set used for scene analysis ────────────────────────────────

function levelView(index: number): ViewSpec {
  return { yaw: VIEW_YAWS_DEG[index] * DEG_TO_RAD, pitch: 0, fovDeg: VIEW_FOV_DEG, size: VIEW_SIZE }
}

/** Point in a view (0–1000 normalised, Gemini box_2d convention) → panorama yaw/pitch. */
export function viewPointToYawPitch(viewIndex: number, x1000: number, y1000: number): { yaw: number; pitch: number } {
  return viewPixelToSpherical(levelView(viewIndex), (x1000 / 1000) * VIEW_SIZE, (y1000 / 1000) * VIEW_SIZE)
}

/** Panorama yaw/pitch → the view where it sits closest to centre, as 0–1000 coords. Null if outside every view. */
export function yawPitchToViewPoint(yaw: number, pitch: number): { view: number; x: number; y: number } | null {
  let best: { view: number; x: number; y: number; d: number } | null = null
  for (let i = 0; i < VIEW_YAWS_DEG.length; i++) {
    const p = sphericalToViewPixel(levelView(i), yaw, pitch)
    if (!p || p.u < 0 || p.u > VIEW_SIZE || p.v < 0 || p.v > VIEW_SIZE) continue
    const d = Math.abs(wrapYaw(yaw - VIEW_YAWS_DEG[i] * DEG_TO_RAD))
    if (!best || d < best.d) {
      best = { view: i, x: Math.round(p.u / VIEW_SIZE * 1000), y: Math.round(p.v / VIEW_SIZE * 1000), d }
    }
  }
  return best && { view: best.view, x: best.x, y: best.y }
}

// ── Sampling ────────────────────────────────────────────────────────────────

/** Renders one perspective view (RGB, size×size) from an equirect source. */
export function renderPerspective(src: EquirectSource, spec: ViewSpec): Buffer {
  const { fullW, fullH } = src
  const S   = spec.size
  const out = Buffer.alloc(S * S * 3)
  const sample = makeSampler(src)

  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const { yaw, pitch } = viewPixelToSpherical(spec, u + 0.5, v + 0.5)
      const ex = (yaw / (2 * Math.PI) + 0.5) * fullW - 0.5
      const ey = (0.5 - pitch / Math.PI) * fullH - 0.5
      sample(ex, ey, out, (v * S + u) * 3)
    }
  }
  return out
}

/** Bilinear sampler in full-panorama pixel coords, wrapping horizontally across the seam. */
function makeSampler(src: EquirectSource) {
  const { data, width: W, height: H, channels: C, fullW, x0, y0 } = src
  const full = W >= fullW
  return (ex: number, ey: number, out: Buffer, o: number) => {
    // A patch may straddle the seam, so measure from x0 going right, modulo the full width
    const px = (((ex - x0) % fullW) + fullW) % fullW
    const py = Math.min(H - 1, Math.max(0, ey - y0))
    const xa0 = Math.floor(px), ya = Math.floor(py)
    const fx = px - xa0, fy = py - ya
    const xa = full ? xa0 % W : Math.min(W - 1, Math.max(0, xa0))
    const xb = full ? (xa0 + 1) % W : Math.min(W - 1, xa0 + 1)
    const yb = Math.min(H - 1, ya + 1)
    for (let c = 0; c < 3; c++) {
      const top = data[(ya * W + xa) * C + c] * (1 - fx) + data[(ya * W + xb) * C + c] * fx
      const bot = data[(yb * W + xa) * C + c] * (1 - fx) + data[(yb * W + xb) * C + c] * fx
      out[o + c] = top * (1 - fy) + bot * fy
    }
  }
}

/**
 * Bounding box (in full-panorama pixels) of everything a view can see.
 * x0 may be negative / x0+width may exceed fullW when the view straddles the seam.
 */
export function viewFootprint(spec: ViewSpec, fullW: number, fullH: number, marginPx = 4) {
  const poleUp   = sphericalToViewPixel(spec, spec.yaw,  Math.PI / 2 - 1e-6)
  const poleDown = sphericalToViewPixel(spec, spec.yaw, -Math.PI / 2 + 1e-6)
  const inView = (p: { u: number; v: number } | null) => !!p && p.u >= 0 && p.u <= spec.size && p.v >= 0 && p.v <= spec.size

  let dMin = Infinity, dMax = -Infinity, pMin = Infinity, pMax = -Infinity
  const N = 48
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * spec.size
    for (const [u, v] of [[t, 0], [t, spec.size], [0, t], [spec.size, t]]) {
      const { yaw, pitch } = viewPixelToSpherical(spec, u, v)
      const d = wrapYaw(yaw - spec.yaw)
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d)
      pMin = Math.min(pMin, pitch); pMax = Math.max(pMax, pitch)
    }
  }

  const yTop    = inView(poleUp)   ? 0     : Math.floor((0.5 - pMax / Math.PI) * fullH) - marginPx
  const yBottom = inView(poleDown) ? fullH : Math.ceil((0.5 - pMin / Math.PI) * fullH) + marginPx
  const y0 = Math.max(0, yTop)
  const height = Math.min(fullH, yBottom) - y0

  if (inView(poleUp) || inView(poleDown) || dMax - dMin > Math.PI * 1.5) {
    return { x0: 0, width: fullW, y0, height }
  }
  const xL = Math.floor(((spec.yaw + dMin) / (2 * Math.PI) + 0.5) * fullW) - marginPx
  const xR = Math.ceil(((spec.yaw + dMax) / (2 * Math.PI) + 0.5) * fullW) + marginPx
  return { x0: xL, width: Math.min(fullW, xR - xL), y0, height }
}

/** Reads just the footprint area of a (possibly huge) panorama file as raw RGB. */
export async function extractFootprint(
  image: Buffer, fullW: number, fullH: number,
  fp: { x0: number; width: number; y0: number; height: number },
): Promise<EquirectSource> {
  const x0 = ((fp.x0 % fullW) + fullW) % fullW
  const pieces = x0 + fp.width <= fullW
    ? [{ left: x0, width: fp.width, at: 0 }]
    : [{ left: x0, width: fullW - x0, at: 0 }, { left: 0, width: fp.width - (fullW - x0), at: fullW - x0 }]

  const out = Buffer.alloc(fp.width * fp.height * 3)
  for (const p of pieces) {
    const buf = await sharp(image, { limitInputPixels: false })
      .extract({ left: p.left, top: fp.y0, width: p.width, height: fp.height })
      .toColourspace('srgb').removeAlpha().raw().toBuffer()
    for (let y = 0; y < fp.height; y++) {
      buf.copy(out, (y * fp.width + p.at) * 3, y * p.width * 3, (y + 1) * p.width * 3)
    }
  }
  return { data: out, width: fp.width, height: fp.height, channels: 3, fullW, fullH, x0, y0: fp.y0 }
}

/** Writes a patch (same layout as extractFootprint's output) back into the panorama; returns a JPEG. */
export async function writeFootprint(image: Buffer, patch: EquirectSource, quality = 92): Promise<Buffer> {
  const { fullW, x0, y0, width, height } = patch
  const pieces = x0 + width <= fullW
    ? [{ left: x0, width, from: 0 }]
    : [{ left: x0, width: fullW - x0, from: 0 }, { left: 0, width: width - (fullW - x0), from: fullW - x0 }]

  const composites = pieces.map(p => {
    const buf = Buffer.alloc(p.width * height * 3)
    for (let y = 0; y < height; y++) {
      patch.data.copy(buf, y * p.width * 3, (y * width + p.from) * 3, (y * width + p.from + p.width) * 3)
    }
    return { input: buf, raw: { width: p.width, height, channels: 3 as const }, left: p.left, top: y0 }
  })

  return sharp(image, { limitInputPixels: false })
    .composite(composites)
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

/** Downloads an equirectangular image and renders the 6 analysis views as base64 JPEGs. */
export async function renderPanoViews(imageUrl: string): Promise<PanoView[]> {
  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`Panorama fetch ${res.status}`)
  const src = await decodeEquirect(Buffer.from(await res.arrayBuffer()))

  const views: PanoView[] = []
  for (let i = 0; i < VIEW_YAWS_DEG.length; i++) {
    const spec = levelView(i)
    views.push({ index: i, yawRad: wrapYaw(spec.yaw), jpegB64: (await rgbToJpeg(renderPerspective(src, spec), spec.size)).toString('base64') })
  }
  return views
}

export async function decodeEquirect(image: Buffer): Promise<EquirectSource> {
  const { data, info } = await sharp(image).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels, fullW: info.width, fullH: info.height, x0: 0, y0: 0 }
}

export function rgbToJpeg(rgb: Buffer, size: number, quality = 85): Promise<Buffer> {
  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality }).toBuffer()
}
