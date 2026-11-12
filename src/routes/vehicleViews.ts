import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema, sendValidationError } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import { invalidateSpaceCache } from '../utils/cache.js'
import { consumeAi, AiLimitError } from '../utils/aiUsage.js'
import { suggestAngles, suggestHotspots } from '../utils/vehicleAi.js'
import { failureReason } from '../utils/gemini.js'

// Single-vehicle exterior: sets of normal photos taken around the car.
// The viewer steps between them as the visitor drags (see
// migration-vehicle-views.sql). A car can have several spins, e.g. roof up and
// roof down (migration-vehicle-spins.sql). Interior is a normal 360 scene.

const spaceParams = z.object({ spaceId: z.string().uuid() })
const viewParams = z.object({ viewId: z.string().uuid() })
const spinParams = z.object({ spinId: z.string().uuid() })

export const MAX_VEHICLE_SPINS = 6
const spinTitle = z.string().trim().min(1).max(40)
/** Camera height of a spin, in degrees: 0 eye level, positive higher, negative lower. */
const elevation = z.number().int().min(-60).max(80)
export const CreateVehicleSpinBody = z.object({
  title: spinTitle,
  /** Makes this spin a camera-height row of another spin (same look, camera higher or lower). */
  row_of: z.string().uuid().optional(),
  elevation: elevation.optional(),
})
export const UpdateVehicleSpinBody = z.object({
  title: spinTitle.optional(),
  start_angle: z.number().int().min(0).max(359).optional(),
  elevation: elevation.optional(),
})
const SpinOrderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(MAX_VEHICLE_SPINS) })
const AiSortBody = z.object({ spin_id: z.string().uuid().optional().nullable() }).optional().nullable()
const SPIN_COLUMNS = 'id, space_id, title, start_angle, order_index, created_at'
const SPIN_ROW_COLUMNS = `${SPIN_COLUMNS}, row_of, elevation`
const ROWS_MIGRATION_MSG = "Spins at several camera heights need a database update first: run migration-vehicle-spin-rows.sql, then NOTIFY pgrst, 'reload schema';"
function missingColumn(error: { code?: string; message?: string } | null | undefined) {
  return !!error && /PGRST20[0-9]|42703|schema cache|does not exist|Could not find/i.test(`${error.code ?? ''} ${error.message ?? ''}`)
}

const safeUrl = z.string().url().refine(u => /^https?:\/\//i.test(u), { message: 'URL must use http or https' })

// Per spin. 72 leaves room for a 64-frame video spin.
export const MAX_VEHICLE_VIEWS = 72

export const CreateVehicleViewBody = z.object({
  /** Which spin the photo belongs to. Omitted: the car's first spin (created if needed). */
  spin_id: z.string().uuid().optional().nullable(),
  image_url: safeUrl,
  media_id: z.string().uuid().optional().nullable(),
  label: z.string().trim().min(1).max(40).optional().nullable(),
  angle: z.number().int().min(0).max(359),
  width: z.number().int().min(1).max(20000).optional().nullable(),
  height: z.number().int().min(1).max(20000).optional().nullable(),
})

export const UpdateVehicleViewBody = z.object({
  label: z.string().trim().min(1).max(40).optional().nullable(),
  angle: z.number().int().min(0).max(359).optional(),
})

export const MAX_HOTSPOTS_PER_VIEW = 20

const hotspotFields = {
  kind: z.enum(['feature', 'damage', 'info', 'link']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().max(400).optional().nullable(),
  url: safeUrl.max(500).optional().nullable(),
  /** A photo that opens from the pin (the engine under the bonnet, the tyre tread). */
  image_url: safeUrl.max(1000).optional().nullable(),
  /**
   * Where the pin sits on each frame of a smooth spin, worked out in the editor by following the
   * part from frame to frame: { pts: { [viewId]: [x, y] } }. `fixed` are frames the seller corrected.
   * Frames missing from `pts` are where the part is out of sight: the pin is hidden there.
   */
  track: z.object({
    pts: z.record(z.string().uuid(), z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
      .refine(p => Object.keys(p).length <= MAX_VEHICLE_VIEWS * 4, { message: 'Too many frames in the track' }),
    fixed: z.array(z.string().uuid()).max(MAX_VEHICLE_VIEWS).optional(),
    // Which tracker made it: the editor re-follows pins made by an older one.
    v: z.number().int().min(1).max(1000).optional(),
  }).optional().nullable(),
}
export const CreateVehicleHotspotBody = z.object(hotspotFields)
export const UpdateVehicleHotspotBody = z.object(hotspotFields).partial()

// Several photos' angles at once (swap two photos, or accept an AI sort) in one write.
const AnglesBody = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    angle: z.number().int().min(0).max(359),
    label: z.string().trim().min(1).max(40).optional().nullable(),
  })).min(1).max(MAX_VEHICLE_VIEWS),
})

const hotspotParams = z.object({ hotspotId: z.string().uuid() })

const HOTSPOT_COLUMNS_BASE = ['id', 'view_id', 'kind', 'x', 'y', 'title', 'body', 'url']
/** Columns added later, each with the migration that adds it. Until it has run, hotspots work without it. */
const HOTSPOT_OPTIONAL: Record<string, { file: string; what: string }> = {
  image_url: { file: 'migration-vehicle-hotspot-image.sql', what: 'Photos on hotspots' },
  track: { file: 'migration-vehicle-hotspot-track.sql', what: 'Hotspots that follow the car' },
}
type DbError = { code?: string; message?: string; details?: string } | null | undefined

/** The optional hotspot column a database error is about (the column does not exist yet), if any. */
export function missingHotspotColumn(error: DbError): string | null {
  if (!error) return null
  const text = `${error.code ?? ''} ${error.message ?? ''} ${error.details ?? ''}`
  if (!/42703|PGRST204|column|schema cache/i.test(text)) return null
  return Object.keys(HOTSPOT_OPTIONAL).find(c => new RegExp(`[^a-z_]${c}[^a-z_]`).test(` ${text} `)) ?? null
}
/** Kept for callers of the first version. */
export function missingHotspotImageColumn(error: DbError): boolean { return missingHotspotColumn(error) === 'image_url' }

const hotspotColumns = (skip: Set<string>) =>
  [...HOTSPOT_COLUMNS_BASE, ...Object.keys(HOTSPOT_OPTIONAL).filter(c => !skip.has(c))].join(', ')

/**
 * Runs a hotspot query, dropping optional columns the database does not have yet. A write that
 * carries a value for a missing column answers which migration to run instead of losing it quietly.
 */
async function hotspotQuery(
  run: (columns: string, skip: Set<string>) => PromiseLike<{ data: any; error: any }>,
  sent: Record<string, unknown> = {},
): Promise<{ data: any; error: any; migration?: string }> {
  const skip = new Set<string>()
  for (;;) {
    const res = await run(hotspotColumns(skip), skip)
    const col = missingHotspotColumn(res.error)
    if (!col || skip.has(col)) return res
    const v = sent[col]
    if (v !== undefined && v !== null) {
      const m = HOTSPOT_OPTIONAL[col]
      return { data: null, error: res.error, migration: `${m.what} need a database update: run ${m.file} in Supabase.` }
    }
    skip.add(col)
  }
}
const omit = (row: Record<string, unknown>, skip: Set<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !skip.has(k)))

const ReorderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(MAX_VEHICLE_VIEWS) })

const LEGACY_COLUMNS = 'id, space_id, media_id, image_url, label, angle, width, height, order_index, created_at'
const COLUMNS = `${LEGACY_COLUMNS}, spin_id`

/** True when the database answered "that table / column is not there" (a migration has not run yet). */
function isMissingSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return /PGRST20[0-9]|42P01|42703|schema cache|does not exist|Could not find/i.test(`${error.code ?? ''} ${error.message ?? ''}`)
}

/**
 * A car's exterior photos, newest schema first. Before migration-vehicle-spins.sql has run there is
 * no spin_id column: the photos are still served, as one spin.
 */
async function selectViews(fastify: FastifyInstance, spaceId: string) {
  const first = await fastify.supabase
    .from('vehicle_views').select(COLUMNS).eq('space_id', spaceId)
    .order('order_index', { ascending: true }).order('created_at', { ascending: true })
  if (!first.error) return { rows: (first.data ?? []) as any[], error: null, spinColumn: true }
  if (!isMissingSchema(first.error)) return { rows: [] as any[], error: first.error, spinColumn: false }
  const legacy = await fastify.supabase
    .from('vehicle_views').select(LEGACY_COLUMNS).eq('space_id', spaceId)
    .order('order_index', { ascending: true }).order('created_at', { ascending: true })
  return { rows: (legacy.data ?? []) as any[], error: legacy.error, spinColumn: false }
}

/**
 * The car's spins in order, or null when the spins table does not exist yet. Each has row_of and
 * elevation; before migration-vehicle-spin-rows.sql they are null and 0 (every spin a main spin).
 */
async function selectSpins(fastify: FastifyInstance, spaceId: string) {
  const query = (cols: string) => fastify.supabase
    .from('vehicle_spins').select(cols).eq('space_id', spaceId)
    .order('order_index', { ascending: true }).order('created_at', { ascending: true })
  const withRows = await query(SPIN_ROW_COLUMNS)
  if (!withRows.error) return (withRows.data ?? []) as any[]
  const plain = await query(SPIN_COLUMNS)
  if (plain.error) return null
  return ((plain.data ?? []) as any[]).map(s => ({ ...s, row_of: null, elevation: 0 }))
}

/**
 * Makes sure every photo belongs to a spin: creates the car's first spin when it has none, and moves
 * photos without one (saved by an older app) into it. Returns the spins, or null before the migration.
 */
async function ensureSpins(fastify: FastifyInstance, spaceId: string, views: any[]) {
  let spins = await selectSpins(fastify, spaceId)
  if (!spins) return null
  const orphans = views.filter(v => !v.spin_id)
  if (!spins.length && (orphans.length || !views.length)) {
    const { data, error } = await fastify.supabase
      .from('vehicle_spins').insert({ space_id: spaceId, title: 'Exterior', order_index: 0 }).select(SPIN_COLUMNS).single()
    if (error || !data) return spins
    spins = [data]
  }
  if (orphans.length && spins.length) {
    const first = spins[0].id
    await fastify.supabase.from('vehicle_views').update({ spin_id: first }).in('id', orphans.map(v => v.id))
    for (const v of orphans) v.spin_id = first
  }
  return spins
}

/** Before the spins migration: one stand-in spin so the app can work the same way. */
const LEGACY_SPIN_ID = '00000000-0000-0000-0000-000000000000'
function legacySpin(spaceId: string) {
  return { id: LEGACY_SPIN_ID, space_id: spaceId, title: 'Exterior', start_angle: 0, order_index: 0, created_at: null }
}

/**
 * Owner-only routes: say what the database actually answered, so a missing table or a stale API
 * schema cache is obvious instead of a bare "failed". (Never used on public routes.)
 */
function dbFailure(base: string, error: { code?: string; message?: string }): string {
  const text = `${error.code ?? ''} ${error.message ?? ''}`
  if (/PGRST205|PGRST200|42P01|schema cache|does not exist/i.test(text)) {
    return `${base}: the database has no car photo table the API can see yet. Run the car photo migration, then run: NOTIFY pgrst, 'reload schema';`
  }
  return `${base} (${(error.code ?? 'db').toString().slice(0, 20)}: ${(error.message ?? 'unknown').slice(0, 160)})`
}

export default async function vehicleViewRoutes(fastify: FastifyInstance) {
  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }
  async function ownedView(viewId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_views')
      .select('id, space_id, media_id, properties!inner(user_id)')
      .eq('id', viewId).eq('properties.user_id', userId).maybeSingle()
    return data
  }

  fastify.get('/spaces/:spaceId/vehicle-views', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { rows, error, spinColumn } = await selectViews(fastify, params.spaceId)
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: dbFailure('Failed to load car photos', error) })
    }
    const spins = spinColumn ? await ensureSpins(fastify, params.spaceId, rows) : null
    const views = spins ? rows : rows.map(v => ({ ...v, spin_id: LEGACY_SPIN_ID }))
    return reply.send({
      vehicle_views: await withHotspots(fastify, views),
      vehicle_spins: spins ?? [legacySpin(params.spaceId)],
      // False until migration-vehicle-spins.sql has run: the editor then offers one spin only.
      spins_ready: !!spins,
    })
  })

  // ── SPINS ─────────────────────────────────────────────────
  async function ownedSpin(spinId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_spins')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', spinId).eq('properties.user_id', userId).maybeSingle()
    return data
  }

  fastify.post('/spaces/:spaceId/vehicle-spins', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateVehicleSpinBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const { rows } = await selectViews(fastify, params.spaceId)
    const spins = await ensureSpins(fastify, params.spaceId, rows)
    if (!spins) {
      return reply.code(503).send({ statusMessage: "A second spin needs a database update first: run migration-vehicle-spins.sql, then NOTIFY pgrst, 'reload schema';" })
    }
    if (spins.length >= MAX_VEHICLE_SPINS) return reply.code(400).send({ statusMessage: `Up to ${MAX_VEHICLE_SPINS} spins per car.` })
    const row: Record<string, unknown> = { space_id: params.spaceId, title: body.title, order_index: spins.length }
    if (body.row_of) {
      // A height row belongs to a main spin of the same car (rows of rows are not allowed).
      const parent = spins.find(s => s.id === body.row_of)
      if (!parent) return reply.code(404).send({ statusMessage: 'Spin not found' })
      if (parent.row_of) return reply.code(400).send({ statusMessage: 'Add the height to the main spin, not to another height.' })
      row.row_of = body.row_of
      row.elevation = body.elevation ?? 30
    } else if (body.elevation != null) {
      row.elevation = body.elevation
    }
    const { data, error } = await fastify.supabase
      .from('vehicle_spins').insert(row).select('*').single()
    if (error) {
      fastify.log.error(error)
      if ((body.row_of || body.elevation != null) && missingColumn(error)) return reply.code(503).send({ statusMessage: ROWS_MIGRATION_MSG })
      return reply.code(500).send({ statusMessage: dbFailure('Failed to add the spin', error) })
    }
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(201).send({ vehicle_spin: data })
  })

  fastify.patch('/vehicle-spins/:spinId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spinParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateVehicleSpinBody, req.body)
    if (!body) return
    const owned = await ownedSpin(params.spinId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Spin not found' })
    const { data, error } = await fastify.supabase
      .from('vehicle_spins')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.spinId).select('*').single()
    if (error) {
      fastify.log.error(error)
      if (body.elevation != null && missingColumn(error)) return reply.code(503).send({ statusMessage: ROWS_MIGRATION_MSG })
      return reply.code(500).send({ statusMessage: 'Failed to save the spin' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ vehicle_spin: data })
  })

  fastify.put('/spaces/:spaceId/vehicle-spins/order', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, SpinOrderBody, req.body)
    if (!body) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const results = await Promise.all(body.orderedIds.map((id, i) =>
      fastify.supabase.from('vehicle_spins').update({ order_index: i }).eq('id', id).eq('space_id', params.spaceId)))
    if (results.some(r => r.error)) return reply.code(500).send({ statusMessage: 'Failed to save the order' })
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(204).send()
  })

  // Deletes the spin with its photos and their hotspots. Answers the photos' media ids so the
  // client can remove the files (same as deleting one photo).
  fastify.delete('/vehicle-spins/:spinId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spinParams, (req as any).params)
    if (!params) return
    const owned = await ownedSpin(params.spinId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Spin not found' })
    // Its height rows go with it (on delete cascade): collect their photos' files too.
    const rows = await fastify.supabase.from('vehicle_spins').select('id').eq('row_of', params.spinId)
    const spinIds = [params.spinId, ...((rows.error ? [] : rows.data ?? []) as any[]).map(r => r.id)]
    const { data: views } = await fastify.supabase.from('vehicle_views').select('media_id').in('spin_id', spinIds)
    const { error } = await fastify.supabase.from('vehicle_spins').delete().eq('id', params.spinId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete the spin' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ media_ids: (views ?? []).map(v => v.media_id).filter(Boolean) })
  })

  // The image is uploaded first via /uploads/create-signed-url (mediaType 'vehicle_view').
  fastify.post('/spaces/:spaceId/vehicle-views', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateVehicleViewBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })

    // Which spin: the one asked for (it must be this car's), else the car's first spin.
    const { rows, spinColumn } = await selectViews(fastify, params.spaceId)
    const spins = spinColumn ? await ensureSpins(fastify, params.spaceId, rows) : null
    let spinId: string | null = null
    if (spins) {
      spinId = body.spin_id && spins.some(s => s.id === body.spin_id) ? body.spin_id : spins[0]?.id ?? null
      if (body.spin_id && body.spin_id !== LEGACY_SPIN_ID && spinId !== body.spin_id) {
        return reply.code(404).send({ statusMessage: 'Spin not found' })
      }
    }
    const count = spins ? rows.filter(v => v.spin_id === spinId).length : rows.length
    if (count >= MAX_VEHICLE_VIEWS) {
      return reply.code(400).send({ statusMessage: `Up to ${MAX_VEHICLE_VIEWS} photos per spin.` })
    }

    const { data, error } = await fastify.supabase
      .from('vehicle_views')
      .insert({
        ...(spinId ? { spin_id: spinId } : {}),
        space_id: params.spaceId,
        image_url: body.image_url,
        media_id: body.media_id ?? null,
        label: body.label ?? null,
        angle: body.angle,
        width: body.width ?? null,
        height: body.height ?? null,
        order_index: count,
      })
      .select(spins ? COLUMNS : LEGACY_COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: dbFailure('Failed to add car photo', error) })
    }
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(201).send({ vehicle_view: spins ? data : { ...(data as any), spin_id: LEGACY_SPIN_ID } })
  })

  fastify.patch('/vehicle-views/:viewId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateVehicleViewBody, req.body)
    if (!body) return
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { data, error } = await fastify.supabase
      .from('vehicle_views')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', params.viewId).select(LEGACY_COLUMNS).single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save car photo' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ vehicle_view: data })
  })

  // Rewrites order_index to match the array position.
  fastify.put('/spaces/:spaceId/vehicle-views/order', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, ReorderBody, req.body)
    if (!body) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const results = await Promise.all(body.orderedIds.map((id, i) =>
      fastify.supabase.from('vehicle_views').update({ order_index: i }).eq('id', id).eq('space_id', params.spaceId)))
    if (results.some(r => r.error)) return reply.code(500).send({ statusMessage: 'Failed to save the order' })
    await invalidateSpaceCache(fastify, params.spaceId)
    return reply.code(204).send()
  })

  // Several angles at once. Used by drag-to-swap in the editor and by "accept AI sort".
  fastify.put('/spaces/:spaceId/vehicle-views/angles', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, AnglesBody, req.body)
    if (!body) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const now = new Date().toISOString()
    const results = await Promise.all(body.items.map(it =>
      fastify.supabase.from('vehicle_views')
        .update({ angle: it.angle, ...(it.label !== undefined ? { label: it.label } : {}), updated_at: now })
        .eq('id', it.id).eq('space_id', params.spaceId)))
    if (results.some(r => r.error)) return reply.code(500).send({ statusMessage: 'Failed to save the new order' })
    await invalidateSpaceCache(fastify, params.spaceId)
    const { rows, spinColumn } = await selectViews(fastify, params.spaceId)
    const views = spinColumn ? rows : rows.map(v => ({ ...v, spin_id: LEGACY_SPIN_ID }))
    return reply.send({ vehicle_views: await withHotspots(fastify, views) })
  })

  // ── HOTSPOTS ──────────────────────────────────────────────
  fastify.post('/vehicle-views/:viewId/hotspots', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, CreateVehicleHotspotBody, req.body)
    if (!body) return
    const quota = await checkUserQuota(fastify, userId)
    if (!quota.canWrite) return reply.code(403).send({ statusMessage: 'Your plan does not allow changes right now. Please renew to continue.' })
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { count } = await fastify.supabase
      .from('vehicle_hotspots').select('id', { count: 'exact', head: true }).eq('view_id', params.viewId)
    if ((count ?? 0) >= MAX_HOTSPOTS_PER_VIEW) {
      return reply.code(400).send({ statusMessage: `Up to ${MAX_HOTSPOTS_PER_VIEW} hotspots per photo.` })
    }
    const row: Record<string, unknown> = { view_id: params.viewId, space_id: owned.space_id, ...body, body: body.body ?? null, url: body.url ?? null }
    const { data, error, migration } = await hotspotQuery(
      (cols, skip) => fastify.supabase.from('vehicle_hotspots').insert(omit(row, skip)).select(cols).single(), body)
    if (migration) return reply.code(503).send({ statusMessage: migration })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: dbFailure('Failed to add hotspot', error) })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(201).send({ hotspot: data })
  })

  async function ownedHotspot(hotspotId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('vehicle_hotspots')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', hotspotId).eq('properties.user_id', userId).maybeSingle()
    return data
  }

  fastify.patch('/vehicle-hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, UpdateVehicleHotspotBody, req.body)
    if (!body) return
    const owned = await ownedHotspot(params.hotspotId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Hotspot not found' })
    const patch: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() }
    const { data, error, migration } = await hotspotQuery(
      (cols, skip) => fastify.supabase.from('vehicle_hotspots').update(omit(patch, skip)).eq('id', params.hotspotId).select(cols).single(), body)
    if (migration) return reply.code(503).send({ statusMessage: migration })
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save hotspot' })
    }
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.send({ hotspot: data })
  })

  fastify.delete('/vehicle-hotspots/:hotspotId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, hotspotParams, (req as any).params)
    if (!params) return
    const owned = await ownedHotspot(params.hotspotId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Hotspot not found' })
    const { error } = await fastify.supabase.from('vehicle_hotspots').delete().eq('id', params.hotspotId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete hotspot' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })

  // ── AI (suggestions only: nothing is saved until the owner accepts) ──
  fastify.post('/spaces/:spaceId/vehicle-views/ai-sort', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI is not configured on the server.' })
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const parsedSort = AiSortBody.safeParse(req.body ?? null)
    if (!parsedSort.success) return sendValidationError(reply, parsedSort.error)
    const sortBody = parsedSort.data

    // One spin at a time: frames of different spins share angles.
    const { rows } = await selectViews(fastify, params.spaceId)
    const wanted = sortBody?.spin_id && sortBody.spin_id !== LEGACY_SPIN_ID ? sortBody.spin_id : null
    const views = rows
      .filter(v => !wanted || v.spin_id === wanted)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, MAX_VEHICLE_VIEWS)
      .map(v => ({ id: v.id, image_url: v.image_url }))
    if (!views.length) return reply.code(400).send({ statusMessage: 'Add some photos first.' })

    let refund: () => Promise<void>
    try { refund = await consumeAi(fastify, userId, 'prompts') } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }
    try {
      return reply.send({ suggestions: await suggestAngles(apiKey, views) })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, spaceId: params.spaceId }, '[vehicle ai-sort] failed')
      await refund().catch(() => {})
      return reply.code(503).send({ reason: failureReason(err), statusMessage: 'Could not sort the photos right now. Try again shortly.' })
    }
  })

  fastify.post('/vehicle-views/:viewId/ai-hotspots', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return reply.code(503).send({ statusMessage: 'AI is not configured on the server.' })
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })

    const [{ data: view }, { data: space }] = await Promise.all([
      fastify.supabase.from('vehicle_views').select('image_url').eq('id', params.viewId).single(),
      fastify.supabase.from('properties').select('title, vehicle_year').eq('id', owned.space_id).single(),
    ])
    if (!view?.image_url) return reply.code(404).send({ statusMessage: 'Car photo not found' })

    let refund: () => Promise<void>
    try { refund = await consumeAi(fastify, userId, 'prompts') } catch (err: any) {
      if (err instanceof AiLimitError) return reply.code(429).send({ statusMessage: err.message })
      throw err
    }
    try {
      const context = [space?.vehicle_year, space?.title].filter(Boolean).join(' ')
      return reply.send({ suggestions: await suggestHotspots(apiKey, view.image_url, context || undefined) })
    } catch (err: any) {
      fastify.log.warn({ err: err.message, viewId: params.viewId }, '[vehicle ai-hotspots] failed')
      await refund().catch(() => {})
      return reply.code(503).send({ reason: failureReason(err), statusMessage: 'Could not suggest hotspots right now. Try again shortly.' })
    }
  })

  // The image file itself is removed by the client via DELETE /uploads/:mediaId.
  fastify.delete('/vehicle-views/:viewId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, viewParams, (req as any).params)
    if (!params) return
    const owned = await ownedView(params.viewId, userId)
    if (!owned) return reply.code(404).send({ statusMessage: 'Car photo not found' })
    const { error } = await fastify.supabase.from('vehicle_views').delete().eq('id', params.viewId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete car photo' })
    await invalidateSpaceCache(fastify, owned.space_id)
    return reply.code(204).send()
  })
}

/** Adds each photo's hotspots. Read separately so a database without the hotspots table still serves photos. */
async function withHotspots(fastify: FastifyInstance, views: any[]) {
  if (!views.length) return views
  const ids = views.map(v => v.id)
  const { data, error } = await hotspotQuery(cols => fastify.supabase
    .from('vehicle_hotspots').select(cols).in('view_id', ids)
    .order('created_at', { ascending: true }))
  const byView = new Map<string, any[]>()
  if (!error) for (const h of data ?? []) byView.set(h.view_id, [...(byView.get(h.view_id) ?? []), h])
  return views.map(v => ({ ...v, hotspots: byView.get(v.id) ?? [] }))
}

/**
 * Public, read-only: a published car's spins, each with its photos and their hotspots
 * (fetched fresh, not cached). Empty spins are left out. Before the spins migration, all
 * photos come back as one spin. A missing table must never break the public tour.
 */
export async function publicVehicleSpins(fastify: FastifyInstance, spaceId: string) {
  const { rows, error, spinColumn } = await selectViews(fastify, spaceId)
  if (error || !rows.length) return []
  const photos = (await withHotspots(fastify, rows)).map((v: any) => ({
    id: v.id, image_url: v.image_url, label: v.label, angle: v.angle, width: v.width, height: v.height,
    order_index: v.order_index, spin_id: v.spin_id ?? null, hotspots: v.hotspots,
  }))
  const spins = spinColumn ? await selectSpins(fastify, spaceId) : null
  if (!spins || !spins.length) {
    return [{ id: LEGACY_SPIN_ID, title: 'Exterior', start_angle: 0, views: photos }]
  }
  const mains = spins.filter(s => !s.row_of)
  const firstId = (mains[0] ?? spins[0]).id
  const viewsOf = (id: string) => photos.filter((p: any) => (p.spin_id ?? firstId) === id)
  return mains
    .map(s => {
      // Camera-height rows ride inside their main spin (older apps simply ignore `rows`).
      const rows = spins
        .filter(r => r.row_of === s.id)
        .map(r => ({ id: r.id, title: r.title, elevation: r.elevation ?? 0, start_angle: r.start_angle ?? 0, views: viewsOf(r.id) }))
        .filter(r => r.views.length > 0)
      return {
        id: s.id, title: s.title, start_angle: s.start_angle ?? 0, elevation: s.elevation ?? 0,
        // Photos saved without a spin (an older app) show in the first one.
        views: viewsOf(s.id),
        ...(rows.length ? { rows } : {}),
      }
    })
    .filter(s => s.views.length > 0)
}
