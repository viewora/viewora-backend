// Object Spotlights: HUD callouts on objects in a scene (migration-spotlights.sql).
// Made by Spotlight Studio on the owner's computer (viewora-app scripts/spotlight/:
// SAM traces the outline, Kokoro records the voice), published here. The server
// only validates, stores and serves: no AI runs on it.
//
// Visitors never hit this server for them: each scene's objects are written to one
// small JSON file on the media domain (content-hashed name, cached for a year), and
// the tour data carries that file's URL. The tour fetches it when the scene opens.
import { createHash, randomBytes } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'

export const MAX_SPOTLIGHTS_PER_SCENE = 12
export const MAX_VOICE_BYTES = 1_500_000         // ~3 minutes of speech
export const STUDIO_KEY_DAYS = 90

const angle = z.number().finite().min(-7).max(7)  // radians, with room for yaw wrap-around

/** What the tour draws (shared/spotlight/types.ts SpotlightObject, minus id / voiceSrc). */
export const SpotlightData = z.object({
  label: z.string().trim().max(40).default(''),
  yaw: angle,
  pitch: z.number().finite().min(-1.6).max(1.6),
  zoom: z.number().min(0).max(100),
  polygon: z.array(z.tuple([angle, z.number().finite().min(-1.6).max(1.6)])).min(3).max(120),
  title: z.string().trim().min(1).max(120),
  lines: z.array(z.string().trim().max(300)).max(6).default([]),
  hint: z.boolean().optional(),
  model: z.object({ src: z.string().url().max(2048), bytes: z.number().int().positive().optional(), scale: z.number().positive().optional() }).nullable().optional(),
}).strict()
export type SpotlightData = z.infer<typeof SpotlightData>

const deg = z.number().finite().min(-360).max(360)
/** Studio's working notes (degrees, as clicked). Free-form beyond these; capped in size. */
export const SpotlightSource = z.object({
  at: z.tuple([deg, deg]),
  points: z.array(z.tuple([deg, deg])).max(40).default([]),
  exclude: z.array(z.tuple([deg, deg])).max(40).default([]),
  zoom: z.union([z.number().min(0).max(100), z.literal('auto')]).optional(),
  voice: z.union([z.string().max(40), z.literal(false)]).optional(),
  say: z.string().max(2000).optional(),
}).passthrough()
  .refine(v => JSON.stringify(v).length <= 8000, { message: 'source too large' })

export const objectKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'lowercase letters, digits and dashes')

/** The table is missing until migration-spotlights.sql has run. */
export function tableMissing(error: any): boolean {
  const m = String(error?.message || '')
  return error?.code === '42P01' || error?.code === 'PGRST205'
    || (/(scene_spotlight|studio_keys)/i.test(m) && /(does not exist|schema cache)/i.test(m))
}

// ── Studio keys ──────────────────────────────────────────────────────────────
// vos_<32 base62>. ~190 bits, so an unsalted SHA-256 is safe and lets us look
// a key up by its hash (same scheme as utils/partnerKeys.ts).

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const STUDIO_KEY_RE = /^vos_[0-9A-Za-z]{32}$/

export function generateStudioKey(): { key: string; prefix: string; hash: string } {
  let secret = ''
  while (secret.length < 32) {
    for (const b of randomBytes(64)) {
      if (b < 248 && secret.length < 32) secret += ALPHABET[b % 62]
    }
  }
  const key = `vos_${secret}`
  return { key, prefix: key.slice(0, 10), hash: hashStudioKey(key) }
}

export function hashStudioKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** The key from an Authorization header, or null when it isn't a Studio key. */
export function parseStudioKey(authorization: unknown): string | null {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null
  const key = authorization.slice(7).trim()
  return STUDIO_KEY_RE.test(key) ? key : null
}

// ── Voice ────────────────────────────────────────────────────────────────────

/** An MP3 from base64, or an error message. Checks the size and that it starts like an MP3. */
export function decodeVoice(b64: string): Buffer | string {
  if (b64.length > Math.ceil(MAX_VOICE_BYTES * 4 / 3) + 8) return 'The voice recording is too long.'
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 64) return 'The voice recording is empty.'
  if (buf.length > MAX_VOICE_BYTES) return 'The voice recording is too long.'
  const id3 = buf.subarray(0, 3).toString('latin1') === 'ID3'
  const frame = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
  if (!id3 && !frame) return 'The voice must be an MP3.'
  return buf
}

// ── Storage ──────────────────────────────────────────────────────────────────

export function mediaBase(): string {
  return process.env.MEDIA_DOMAIN || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`
}

/** Under the scene's folder, so deleting the tour (routes/spaces.ts) removes these too. */
export function spotlightPrefix(spaceId: string, sceneId: string): string {
  return `spaces/${spaceId}/scenes/${sceneId}/spotlights`
}

export async function putPublic(fastify: FastifyInstance, key: string, body: Buffer | string, contentType: string): Promise<string> {
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) throw new Error('Storage configuration error')
  await fastify.s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `${mediaBase()}/${key}`
}

export async function storeVoice(fastify: FastifyInstance, spaceId: string, sceneId: string, key: string, mp3: Buffer): Promise<string> {
  const hash = createHash('sha256').update(mp3).digest('hex').slice(0, 12)
  return putPublic(fastify, `${spotlightPrefix(spaceId, sceneId)}/${key}-${hash}.mp3`, mp3, 'audio/mpeg')
}

/** The file the tour reads (shared/spotlight/types.ts SpotlightScene). */
export function sceneFile(sceneId: string, rows: Array<{ object_key: string; data: any; voice_url: string | null }>) {
  return {
    v: 1 as const,
    scene: sceneId,
    objects: rows.map(r => ({
      id: r.object_key,
      ...r.data,
      ...(r.voice_url ? { voiceSrc: r.voice_url } : {}),
    })),
  }
}

/**
 * Rewrites a scene's published file from its rows (or drops it when none are
 * left). Old files are left in place: a visitor who loaded the tour a moment
 * ago may still fetch one. They are a kilobyte or two each and go with the tour.
 */
export async function publishScene(fastify: FastifyInstance, spaceId: string, sceneId: string): Promise<string | null> {
  const { data: rows, error } = await fastify.supabase
    .from('scene_spotlights')
    .select('object_key, data, voice_url, order_index, created_at')
    .eq('scene_id', sceneId)
    .order('order_index', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  if (!rows?.length) {
    await fastify.supabase.from('scene_spotlight_files').delete().eq('scene_id', sceneId)
    return null
  }
  const json = JSON.stringify(sceneFile(sceneId, rows as any[]))
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 12)
  const url = await putPublic(fastify, `${spotlightPrefix(spaceId, sceneId)}/scene-${hash}.json`, json, 'application/json')
  const { error: upErr } = await fastify.supabase
    .from('scene_spotlight_files')
    .upsert({ scene_id: sceneId, space_id: spaceId, url, object_count: rows.length, updated_at: new Date().toISOString() })
  if (upErr) throw upErr
  return url
}

/**
 * Puts spotlight_url on each scene of a public tour that has spotlights. Read
 * fresh like the gallery (not in get_tour_data's cached blob); a database
 * without the table (migration not run) just has none.
 */
export async function mergeSpotlightUrls(fastify: FastifyInstance, spaceId: string, scenes: any[] | null | undefined): Promise<void> {
  if (!Array.isArray(scenes) || !scenes.length) return
  const { data, error } = await fastify.supabase
    .from('scene_spotlight_files')
    .select('scene_id, url')
    .eq('space_id', spaceId)
  if (error || !data?.length) return
  const byId = new Map((data as any[]).map(r => [r.scene_id, r.url]))
  for (const s of scenes) if (byId.has(s.id)) s.spotlight_url = byId.get(s.id)
}
