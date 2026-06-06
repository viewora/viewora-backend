/**
 * Bulk floor-plan generator script.
 *
 * Generates (or regenerates) the automated floor plan for every space that
 * has at least one fully-tiled scene. Safe to re-run — it overwrites the
 * existing floor plan SVG in R2 and updates floorplan_url + position_x/y.
 *
 * Usage:
 *   npx tsx src/scripts/generate_floor_plans.ts
 *
 * Optional — target a single space:
 *   SPACE_ID=<uuid> npx tsx src/scripts/generate_floor_plans.ts
 */

import { createClient as createSupabase } from '@supabase/supabase-js'
import { createClient as createRedis } from 'redis'
import { S3Client } from '@aws-sdk/client-s3'
import dotenv from 'dotenv'
import { generateSpaceFloorPlan } from '../utils/floor-plan-generator.js'

dotenv.config()

// ── Validate env ──────────────────────────────────────────────────────────
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
const missing = required.filter(k => !process.env[k])
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// ── Clients ───────────────────────────────────────────────────────────────
const supabase = createSupabase(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const cdnBase = process.env.MEDIA_DOMAIN
  || `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
  // Optional single-space mode
  const targetSpaceId = process.env.SPACE_ID?.trim() || null

  // Connect Redis (optional — used only for cache busting)
  let redis: ReturnType<typeof createRedis> | null = null
  if (process.env.REDIS_URL) {
    redis = createRedis({ url: process.env.REDIS_URL })
    redis.on('error', () => {}) // non-fatal
    await redis.connect().catch(() => { redis = null })
  }

  // Fetch spaces that have at least one scene with tiles_ready = true
  const spacesQuery = supabase
    .from('properties')
    .select('id, title, slug')
    .order('created_at', { ascending: true })

  if (targetSpaceId) spacesQuery.eq('id', targetSpaceId)

  const { data: allSpaces, error: spacesErr } = await spacesQuery
  if (spacesErr || !allSpaces?.length) {
    console.error('Failed to fetch spaces:', spacesErr?.message ?? 'none found')
    process.exit(1)
  }

  // Filter to spaces that actually have ready scenes
  const { data: readySceneRows } = await supabase
    .from('scenes')
    .select('space_id')
    .eq('tiles_ready', true)
    .in('space_id', allSpaces.map(s => s.id))

  const spacesWithTiles = new Set((readySceneRows ?? []).map((r: any) => r.space_id))
  const spaces = allSpaces.filter(s => spacesWithTiles.has(s.id))

  if (!spaces.length) {
    console.log('No spaces with fully-tiled scenes found. Upload and process some panoramas first.')
    await redis?.quit()
    return
  }

  console.log(`\nGenerating floor plans for ${spaces.length} space(s)...\n`)

  const results = { ok: 0, failed: 0, skipped: 0 }

  for (const space of spaces) {
    const label = `"${space.title || space.slug || space.id}" (${space.id})`
    process.stdout.write(`  → ${label} ... `)

    try {
      const url = await generateSpaceFloorPlan(
        s3,
        supabase,
        space.id,
        cdnBase,
        redis ? {
          del: (key: string) => redis!.del(key),
        } : null,
      )

      if (url) {
        console.log(`done`)
        results.ok++
      } else {
        console.log(`skipped (no scenes or no hotspots)`)
        results.skipped++
      }
    } catch (err: any) {
      console.log(`FAILED — ${err.message}`)
      results.failed++
    }
  }

  console.log(`\nResults: ${results.ok} generated · ${results.skipped} skipped · ${results.failed} failed\n`)

  if (results.ok > 0) {
    console.log('Floor plans are live. Open any published tour — the map appears in the bottom-left corner of the viewer.')
  }

  await redis?.quit()
}

run().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
