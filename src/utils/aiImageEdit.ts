import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { generateGeminiImage } from './gemini.js'
import { industryFor } from './industry.js'
import {
  type EquirectSource, type ViewSpec,
  extractFootprint, renderPerspective, rgbToJpeg, sphericalToViewPixel,
  viewFootprint, viewPixelToSpherical, writeFootprint,
} from './panoViews.js'

// AI photo edits on a 360° panorama ("remove the bin", "add a stack of books here").
//
// The image model can't edit an equirectangular image without bending it, so:
//   1. preview — render a flat perspective crop around the area the owner drew
//      (at the panorama's native resolution), send it to the image model, and
//      store before/after crops in R2. This is the billed step.
//   2. apply   — project the edited crop back onto the full-resolution panorama,
//      blending ONLY inside the drawn area (feathered edge), upload it as a new
//      panorama and re-tile into a fresh tile folder (tiles are cached as immutable).
//      The original panorama is kept in scenes.original_raw_image_url for undo.

const CROP_SIZE       = 1024
const MIN_FOV_DEG     = 20
const MAX_FOV_DEG     = 100
const CONTEXT_FACTOR  = 1.8    // crop shows ~1.8× the drawn area so the model sees surroundings
const FEATHER_FRAC    = 0.06   // soft edge, as a fraction of the drawn area's size

export type SphericalPoint = { yaw: number; pitch: number }

export type EditMeta = {
  editId:      string
  sceneId:     string
  rawImageUrl: string
  view:        ViewSpec
  mask:        { x0: number; y0: number; x1: number; y1: number }   // crop pixels
  instruction: string
  createdAt:   string
}

function mediaDomain(): string {
  return process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`
}

function editPrefix(spaceId: string, sceneId: string, editId: string): string {
  return `spaces/${spaceId}/scenes/${sceneId}/ai-edits/${editId}`
}

/** Where applyEdit stores the edited full panorama (deterministic so the worker job can retry safely). */
export function editPanoramaUrl(spaceId: string, sceneId: string, editId: string): string {
  return `${mediaDomain()}/${editPrefix(spaceId, sceneId, editId)}/panorama.jpg`
}

async function put(s3: S3Client, key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({
    Bucket:       process.env.R2_BUCKET_NAME!,
    Key:          key,
    Body:         body,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `${mediaDomain()}/${key}`
}

async function get(s3: S3Client, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }))
  return Buffer.from(await res.Body!.transformToByteArray())
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Panorama download failed (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

function toVec(p: SphericalPoint): [number, number, number] {
  return [Math.cos(p.pitch) * Math.sin(p.yaw), Math.sin(p.pitch), Math.cos(p.pitch) * Math.cos(p.yaw)]
}

/** Camera that looks at the drawn area with some surroundings, and where the area sits in it. */
export function viewForRegion(corners: SphericalPoint[]) {
  const vs  = corners.map(toVec)
  const sum = vs.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0])
  const len = Math.hypot(...sum) || 1
  const c   = sum.map(n => n / len)
  const centre = { yaw: Math.atan2(c[0], c[2]), pitch: Math.asin(Math.max(-1, Math.min(1, c[1]))) }

  const maxAngle = Math.max(...vs.map(v => Math.acos(Math.max(-1, Math.min(1, v[0] * c[0] + v[1] * c[1] + v[2] * c[2])))))
  const fovDeg   = Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, (2 * maxAngle * CONTEXT_FACTOR) * 180 / Math.PI))
  const view: ViewSpec = { ...centre, fovDeg, size: CROP_SIZE }

  const px = corners.map(p => sphericalToViewPixel(view, p.yaw, p.pitch)).filter(Boolean) as Array<{ u: number; v: number }>
  if (px.length < corners.length) throw new Error('Selected area is too large — draw a smaller box')
  const clamp = (n: number) => Math.max(0, Math.min(CROP_SIZE, n))
  const mask = {
    x0: clamp(Math.min(...px.map(p => p.u))), x1: clamp(Math.max(...px.map(p => p.u))),
    y0: clamp(Math.min(...px.map(p => p.v))), y1: clamp(Math.max(...px.map(p => p.v))),
  }
  if (mask.x1 - mask.x0 < 8 || mask.y1 - mask.y0 < 8) throw new Error('Selected area is too small')
  return { view, mask }
}

function outlined(rgb: Buffer, mask: EditMeta['mask']): Buffer {
  const out = Buffer.from(rgb)
  const t = 4
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= CROP_SIZE || y >= CROP_SIZE) return
    const o = (y * CROP_SIZE + x) * 3
    out[o] = 255; out[o + 1] = 0; out[o + 2] = 0
  }
  const [x0, y0, x1, y1] = [mask.x0, mask.y0, mask.x1, mask.y1].map(Math.round)
  for (let k = 0; k < t; k++) {
    for (let x = x0; x <= x1; x++) { paint(x, y0 - k); paint(x, y1 + k) }
    for (let y = y0; y <= y1; y++) { paint(x0 - k, y); paint(x1 + k, y) }
  }
  return out
}

/** The drawn area with surroundings and a red outline — what the assistant model is shown. */
export function renderRegionPreview(src: EquirectSource, corners: SphericalPoint[]) {
  const { view, mask } = viewForRegion(corners)
  return { view, mask, rgb: outlined(renderPerspective(src, view), mask) }
}

export async function previewEdit(opts: {
  s3:          S3Client
  apiKey:      string
  spaceId:     string
  sceneId:     string
  spaceType:   string | null
  rawImageUrl: string
  corners:     SphericalPoint[]
  instruction: string
}) {
  const raw  = await download(opts.rawImageUrl)
  const meta = await sharp(raw, { limitInputPixels: false }).metadata()
  const fullW = meta.width!, fullH = meta.height!
  const { view, mask } = viewForRegion(opts.corners)

  const src    = await extractFootprint(raw, fullW, fullH, viewFootprint(view, fullW, fullH))
  const before = renderPerspective(src, view)
  const beforeJpeg = await rgbToJpeg(before, CROP_SIZE, 92)
  const refJpeg    = await rgbToJpeg(outlined(before, mask), CROP_SIZE, 85)

  const industry = industryFor(opts.spaceType).label
  const editedRaw = await generateGeminiImage({
    apiKey: opts.apiKey,
    parts: [
      { text: [
        `This is a flat crop from a 360° virtual tour photo of a ${industry}.`,
        'IMAGE 1 is the photo to edit. IMAGE 2 is the same photo with a red rectangle marking the area to change.',
        `Edit IMAGE 1: ${opts.instruction}`,
        'Change ONLY what is inside the red rectangle. Everything outside it must stay exactly as it is — same framing, perspective, lighting, colours and grain.',
        'The result must be photorealistic and match the room\'s lighting and camera perspective. Do NOT draw the red rectangle in the output.',
        'Return one image, the same framing as IMAGE 1.',
      ].join('\n') },
      { text: 'IMAGE 1:' },
      { inline_data: { mime_type: 'image/jpeg', data: beforeJpeg.toString('base64') } },
      { text: 'IMAGE 2:' },
      { inline_data: { mime_type: 'image/jpeg', data: refJpeg.toString('base64') } },
    ],
  })
  // Models may return a different size — normalise to the crop grid
  const afterJpeg = await sharp(editedRaw).resize(CROP_SIZE, CROP_SIZE, { fit: 'fill' }).jpeg({ quality: 92 }).toBuffer()

  const editId = randomUUID()
  const prefix = editPrefix(opts.spaceId, opts.sceneId, editId)
  const editMeta: EditMeta = {
    editId, sceneId: opts.sceneId, rawImageUrl: opts.rawImageUrl, view, mask,
    instruction: opts.instruction, createdAt: new Date().toISOString(),
  }
  const [beforeUrl, afterUrl] = await Promise.all([
    put(opts.s3, `${prefix}/before.jpg`, beforeJpeg, 'image/jpeg'),
    put(opts.s3, `${prefix}/after.jpg`,  afterJpeg,  'image/jpeg'),
    put(opts.s3, `${prefix}/meta.json`,  Buffer.from(JSON.stringify(editMeta)), 'application/json'),
  ])
  return { editId, beforeUrl, afterUrl }
}

/** Projects an approved edit onto the full panorama. Returns the new panorama's public URL. */
export async function applyEdit(opts: {
  s3:          S3Client
  spaceId:     string
  sceneId:     string
  editId:      string
  currentRaw:  string
}): Promise<string> {
  const prefix = editPrefix(opts.spaceId, opts.sceneId, opts.editId)
  const meta = JSON.parse((await get(opts.s3, `${prefix}/meta.json`)).toString()) as EditMeta
  if (meta.rawImageUrl !== opts.currentRaw) {
    throw Object.assign(new Error('This photo has changed since the preview was made — create the edit again.'), { statusCode: 409 })
  }

  const [raw, afterJpeg] = await Promise.all([download(meta.rawImageUrl), get(opts.s3, `${prefix}/after.jpg`)])
  const newJpeg = await compositeEdit(raw, meta, afterJpeg)
  return put(opts.s3, `${prefix}/panorama.jpg`, newJpeg, 'image/jpeg')
}

/** Pure step of applyEdit: blends the edited crop into the full panorama, only under the drawn area. */
export async function compositeEdit(raw: Buffer, meta: Pick<EditMeta, 'view' | 'mask'>, editedJpeg: Buffer): Promise<Buffer> {
  const info  = await sharp(raw, { limitInputPixels: false }).metadata()
  const fullW = info.width!, fullH = info.height!
  const { data: edited } = await sharp(editedJpeg)
    .resize(meta.view.size, meta.view.size, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true })

  const { view, mask } = meta
  const feather = Math.max(4, FEATHER_FRAC * Math.max(mask.x1 - mask.x0, mask.y1 - mask.y0))
  const fp = rectFootprint(view, {
    x0: mask.x0 - feather, y0: mask.y0 - feather, x1: mask.x1 + feather, y1: mask.y1 + feather,
  }, fullW, fullH)
  const patch = await extractFootprint(raw, fullW, fullH, fp)
  blendInto(patch, edited, view, mask, feather)
  return writeFootprint(raw, patch, 92)
}

/** Panorama pixels covered by a rectangle of a view (edges sampled; poles handled). */
function rectFootprint(view: ViewSpec, r: EditMeta['mask'], fullW: number, fullH: number) {
  const pts: SphericalPoint[] = []
  for (let t = 0; t <= 32; t++) {
    const u = r.x0 + (r.x1 - r.x0) * t / 32, v = r.y0 + (r.y1 - r.y0) * t / 32
    pts.push(
      viewPixelToSpherical(view, u, r.y0), viewPixelToSpherical(view, u, r.y1),
      viewPixelToSpherical(view, r.x0, v), viewPixelToSpherical(view, r.x1, v),
    )
  }
  const inRect = (p: { u: number; v: number } | null) => !!p && p.u >= r.x0 && p.u <= r.x1 && p.v >= r.y0 && p.v <= r.y1
  const poleUp   = inRect(sphericalToViewPixel(view, 0,  Math.PI / 2 - 1e-6))
  const poleDown = inRect(sphericalToViewPixel(view, 0, -Math.PI / 2 + 1e-6))

  const pMax = poleUp   ?  Math.PI / 2 : Math.max(...pts.map(p => p.pitch))
  const pMin = poleDown ? -Math.PI / 2 : Math.min(...pts.map(p => p.pitch))
  const y0 = Math.max(0, Math.floor((0.5 - pMax / Math.PI) * fullH) - 4)
  const y1 = Math.min(fullH, Math.ceil((0.5 - pMin / Math.PI) * fullH) + 4)
  if (poleUp || poleDown) return { x0: 0, width: fullW, y0, height: y1 - y0 }

  const ds = pts.map(p => Math.atan2(Math.sin(p.yaw - view.yaw), Math.cos(p.yaw - view.yaw)))
  const x0 = Math.floor(((view.yaw + Math.min(...ds)) / (2 * Math.PI) + 0.5) * fullW) - 4
  const x1 = Math.ceil(((view.yaw + Math.max(...ds)) / (2 * Math.PI) + 0.5) * fullW) + 4
  return { x0, width: Math.min(fullW, x1 - x0), y0, height: y1 - y0 }
}

/** Blends the edited crop into the panorama patch, weight 1 inside the mask fading to 0 over `feather` px. */
function blendInto(patch: EquirectSource, edited: Buffer, view: ViewSpec, mask: EditMeta['mask'], feather: number) {
  const { data, width: W, height: H, fullW, fullH, x0, y0 } = patch
  const S = view.size
  for (let py = 0; py < H; py++) {
    const pitch = (0.5 - (y0 + py + 0.5) / fullH) * Math.PI
    for (let px = 0; px < W; px++) {
      const yaw = ((((x0 + px) % fullW) + 0.5) / fullW - 0.5) * 2 * Math.PI
      const p = sphericalToViewPixel(view, yaw, pitch)
      if (!p) continue
      // Distance outside the mask rectangle (0 inside)
      const dx = Math.max(mask.x0 - p.u, 0, p.u - mask.x1)
      const dy = Math.max(mask.y0 - p.v, 0, p.v - mask.y1)
      const d  = Math.hypot(dx, dy)
      if (d >= feather) continue
      const t = 1 - d / feather
      const w = t * t * (3 - 2 * t)   // smoothstep

      const u = Math.min(S - 1.001, Math.max(0, p.u - 0.5)), v = Math.min(S - 1.001, Math.max(0, p.v - 0.5))
      const ua = Math.floor(u), va = Math.floor(v), fu = u - ua, fv = v - va
      const o = (py * W + px) * 3
      for (let c = 0; c < 3; c++) {
        const top = edited[(va * S + ua) * 3 + c] * (1 - fu) + edited[(va * S + ua + 1) * 3 + c] * fu
        const bot = edited[((va + 1) * S + ua) * 3 + c] * (1 - fu) + edited[((va + 1) * S + ua + 1) * 3 + c] * fu
        data[o + c] = data[o + c] * (1 - w) + (top * (1 - fv) + bot * fv) * w
      }
    }
  }
}
