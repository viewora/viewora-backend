import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  frameStats, smoothLap, planSpinGrade, frameGrade, applyGrade, applyLocalTone, sCurve, enhanceFrame, type FrameStats,
} from '../utils/spinEnhance.js'
import {
  studioKey, originalOf, lookOf, keyFromUrl, spinLookSummary, planId, studioPrefix, runSpinLook, type SpinLookDeps,
} from '../utils/spinLook.js'
import { SpinLookBody } from '../routes/spinLook.js'

const flat = (v: number): FrameStats => ({ mean: v, low: 10, high: 255, grey: [v, v, v] })

test('frameStats: percentiles, mean and the grey of near-neutral midtones', () => {
  const px = new Uint8Array(300 * 3)
  for (let i = 0; i < 300; i++) { px[i * 3] = 120; px[i * 3 + 1] = 110; px[i * 3 + 2] = 100 }
  const s = frameStats(px, 3)
  assert.ok(Math.abs(s.mean - 111.4) < 1)
  assert.equal(s.low, s.high)
  assert.deepEqual(s.grey?.map(Math.round), [120, 110, 100])
})

test('smoothLap wraps round the lap', () => {
  const out = smoothLap([100, 0, 0, 0, 0, 0, 0, 0], 1)
  assert.ok(Math.abs(out[7] - 100 / 3) < 1e-9, 'the last frame sits next to the first')
  assert.ok(Math.abs(out[1] - 100 / 3) < 1e-9)
  assert.equal(out[4], 0)
})

test('planSpinGrade: an even lap is left alone; a frame brighter than its neighbours is brought down', () => {
  const even = planSpinGrade(Array.from({ length: 16 }, () => flat(100)), 'natural')
  assert.ok(even.gains.every(g => Math.abs(g - 1) < 1e-9))
  const jumpy = Array.from({ length: 16 }, () => flat(100))
  jumpy[5] = flat(130)
  const plan = planSpinGrade(jumpy, 'natural')
  assert.ok(plan.gains[5] < 0.9 && plan.gains[5] >= 0.87, 'within the 15% limit')
  assert.ok(plan.gains[0] > 0.99)
})

test('planSpinGrade: white balance is partial and capped', () => {
  const warm = Array.from({ length: 8 }, () => ({ ...flat(120), grey: [160, 120, 80] as [number, number, number] }))
  const { wb } = planSpinGrade(warm, 'natural')
  assert.ok(wb[0] < 1 && wb[2] > 1)
  assert.ok(wb.every(g => g >= 0.88 && g <= 1.12))
})

test('sCurve keeps black, mid grey and white, and barely touches dark tones (dark paint stays readable)', () => {
  for (const s of [0.35, 0.55]) {
    assert.equal(sCurve(0, s), 0)
    assert.ok(Math.abs(sCurve(0.5, s) - 0.5) < 1e-9)
    assert.ok(Math.abs(sCurve(1, s) - 1) < 1e-9)
    // Regression: a full S-curve took navy paint at 0.12 down to ~0.08 (a silhouette).
    assert.ok(sCurve(0.12, s) > 0.1, `dark tone kept at strength ${s}`)
    assert.ok(sCurve(0.8, s) > 0.8, 'highlights gain contrast')
  }
})

test('applyGrade: vibrance lifts muted colours but never near-greys (no colour speckle on white paint)', () => {
  const plan = planSpinGrade(Array.from({ length: 4 }, () => flat(128)), 'vivid')
  const g = frameGrade(plan, 0)
  const px = new Uint8Array([200, 198, 202, /* near-white */ 150, 110, 100 /* muted red */])
  const lr = [g.lut[0][200], g.lut[1][198], g.lut[2][202]]
  applyGrade(px, 3, g)
  assert.deepEqual([px[0], px[1], px[2]], lr, 'near-grey only goes through the tables')
  const spreadBefore = g.lut[0][150] - g.lut[2][100]
  assert.ok(px[3] - px[5] > spreadBefore, 'muted colour is more saturated')
})

test('applyLocalTone: pixel noise is not amplified (clarity reads the small copy, not single pixels)', () => {
  const w = 16, h = 16
  const px = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { const v = 128 + (i % 2 ? 6 : -6); px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = v }
  const before = Uint8Array.from(px)
  const grey = { data: new Uint8Array(4).fill(140), w: 2, h: 2 } // mid surroundings: no shadow lift or highlight hold
  applyLocalTone(px, 3, w, h, grey, grey, grey, { clarity: 0.6, shadows: 0.8, highlights: 0.5 })
  assert.deepEqual(px, before)
})

test('applyLocalTone: dark surroundings lift dark pixels; bright surroundings hold back highlights', () => {
  const dark = new Uint8Array([30, 30, 30]), bright = new Uint8Array([240, 240, 240])
  const lo = { data: new Uint8Array(4).fill(30), w: 2, h: 2 }
  const hi = { data: new Uint8Array(4).fill(250), w: 2, h: 2 }
  applyLocalTone(dark, 3, 1, 1, lo, lo, lo, { clarity: 0, shadows: 0.55, highlights: 0 })
  applyLocalTone(bright, 3, 1, 1, hi, hi, hi, { clarity: 0, shadows: 0, highlights: 0.35 })
  assert.ok(dark[0] > 40)
  assert.ok(bright[0] < 235)
})

test('enhanceFrame: a smooth gradient stays smooth (regression: a 3-channel blur read as 1 channel drew stripes)', async () => {
  const w = 320, h = 180
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 60 + Math.round((x / w) * 120); const i = (y * w + x) * 3
    raw[i] = raw[i + 1] = raw[i + 2] = v
  }
  const file = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  const plan = planSpinGrade([await (await import('../utils/spinEnhance.js')).measureFrame(file)], 'vivid')
  const out = await enhanceFrame(file, frameGrade(plan, 0), 'vivid')
  assert.equal(out.width, w)
  assert.equal(out.height, h)
  const { data } = await sharp(out.buffer).greyscale().raw().toBuffer({ resolveWithObject: true })
  // Every row of a horizontal gradient should match the middle row (JPEG allows a little).
  const mid = Math.floor(h / 2)
  let worst = 0
  for (let y = 4; y < h - 4; y++) for (let x = 8; x < w - 8; x += 7) worst = Math.max(worst, Math.abs(data[y * w + x] - data[mid * w + x]))
  assert.ok(worst <= 6, `rows differ by ${worst}`)
})

test('studio keys: the original is always recoverable, and the look is read from the URL', () => {
  const k = 'users/u/spaces/s/vehicle/17-ab.jpg'
  const sk = studioKey(k, 'natural', 'deadbeef')
  assert.equal(sk, 'users/u/spaces/s/vehicle/17-ab.jpg.studio-natural-v1-deadbeef.jpg')
  assert.ok(sk.startsWith(studioPrefix(k)))
  assert.equal(originalOf(sk), k)
  assert.equal(originalOf(k), k)
  assert.equal(lookOf(`https://m.x/${sk}`), 'natural')
  assert.equal(lookOf(`https://m.x/${k}`), 'original')
  assert.equal(planId({ a: 1 }), planId({ a: 1 }))
  assert.notEqual(planId({ a: 1 }), planId({ a: 2 }))
})

test('keyFromUrl only accepts our media domain', () => {
  assert.equal(keyFromUrl('https://media.viewora.software/users/a/b.jpg', 'https://media.viewora.software'), 'users/a/b.jpg')
  assert.equal(keyFromUrl('https://evil.example/users/a/b.jpg', 'https://media.viewora.software'), null)
  assert.equal(keyFromUrl('https://media.viewora.software/users/a/..%2F..%2Fx.jpg', 'https://media.viewora.software'), null)
  assert.equal(keyFromUrl('not a url', 'https://media.viewora.software'), null)
})

test('spinLookSummary: the look most photos have, and how many were added since', () => {
  const o = 'https://m.x/a.jpg', n = 'https://m.x/a.jpg.studio-natural-v1-deadbeef.jpg'
  assert.deepEqual(spinLookSummary([]), { look: 'original', behind: 0 })
  assert.deepEqual(spinLookSummary([o, o]), { look: 'original', behind: 0 })
  assert.deepEqual(spinLookSummary([n, n, o]), { look: 'natural', behind: 1 })
})

test('the look body only accepts the three choices', () => {
  assert.equal(SpinLookBody.safeParse({ look: 'vivid' }).success, true)
  assert.equal(SpinLookBody.safeParse({ look: 'neon' }).success, false)
})

// ── The job, with storage and database faked ──

const DOMAIN = 'https://media.test'
async function photo(v: number) {
  return sharp({ create: { width: 64, height: 36, channels: 3, background: { r: v, g: v, b: v } } }).jpeg().toBuffer()
}

async function fakeCar(frames: { id: string; angle: number; spin_id: string; v: number; url?: string }[]) {
  const store = new Map<string, Buffer>()
  const rows = new Map<string, { id: string; image_url: string; angle: number; spin_id: string }>()
  for (const f of frames) {
    const key = `cars/${f.id}.jpg`
    store.set(key, await photo(f.v))
    rows.set(f.id, { id: f.id, angle: f.angle, spin_id: f.spin_id, image_url: f.url ?? `${DOMAIN}/${key}` })
  }
  const log: string[] = []
  const deps: SpinLookDeps = {
    mediaDomains: ['https://configured.example', DOMAIN],
    frames: async () => [...rows.values()].map(r => ({ ...r })),
    read: async k => { const b = store.get(k); if (!b) throw new Error('missing ' + k); return b },
    exists: async k => store.has(k),
    write: async (k, b) => { log.push('write'); store.set(k, b) },
    setUrls: async list => { log.push(`set:${list.length}`); for (const r of list) rows.get(r.id)!.image_url = r.image_url },
    remove: async keys => { for (const k of keys) { log.push('remove'); store.delete(k) } },
    progress: async p => { log.push(`p:${p.state}:${p.done}`) },
  }
  return { deps, store, rows, log }
}

test('runSpinLook: every frame is finished before the spin switches, all at once', async () => {
  const car = await fakeCar([0, 90, 180, 270].map((a, i) => ({ id: `f${i}`, angle: a, spin_id: 's1', v: 90 + i * 10 })))
  const r = await runSpinLook(car.deps, 'natural')
  assert.equal(r.changed, 4)
  const setAt = car.log.indexOf('set:4')
  assert.ok(setAt > car.log.lastIndexOf('write'), 'switch after the last copy is saved')
  assert.equal(car.log.filter(l => l.startsWith('set:')).length, 1, 'one switch')
  assert.equal(car.log.at(-1), 'p:done:4')
  for (const row of car.rows.values()) {
    assert.equal(lookOf(row.image_url), 'natural')
    assert.ok(car.store.has(keyFromUrl(row.image_url, DOMAIN)!), 'the URL points at a saved copy')
    assert.ok(car.store.has(keyFromUrl(originalOf(row.image_url), DOMAIN)!), 'the original is kept')
  }
})

test('runSpinLook: a retried job reuses its copies; going back to original restores every URL and tidies up', async () => {
  const car = await fakeCar([0, 120, 240].map((a, i) => ({ id: `f${i}`, angle: a, spin_id: 's1', v: 100 })))
  await runSpinLook(car.deps, 'vivid')
  const writes = car.log.filter(l => l === 'write').length
  // Simulate a retry after a crash just before the switch: point back at originals, run again.
  for (const row of car.rows.values()) row.image_url = originalOf(row.image_url)
  await runSpinLook(car.deps, 'vivid')
  assert.equal(car.log.filter(l => l === 'write').length, writes, 'nothing re-encoded')

  const copies = [...car.store.keys()].filter(k => k.includes('.studio-'))
  await runSpinLook(car.deps, 'original')
  for (const row of car.rows.values()) assert.equal(lookOf(row.image_url), 'original')
  for (const k of copies) assert.equal(car.store.has(k), false, 'copies no photo uses are removed')
})

test('runSpinLook: each camera height is planned on its own, and photos from elsewhere are left alone', async () => {
  const car = await fakeCar([
    // Main lap jumps in exposure (its gains differ from 1); the high lap is even.
    { id: 'a', angle: 0, spin_id: 'main', v: 60 }, { id: 'b', angle: 120, spin_id: 'main', v: 110 }, { id: 'b2', angle: 240, spin_id: 'main', v: 60 },
    { id: 'c', angle: 0, spin_id: 'high', v: 170 }, { id: 'd', angle: 180, spin_id: 'high', v: 170 },
    { id: 'e', angle: 90, spin_id: 'main', v: 80, url: 'https://elsewhere.example/x.jpg' },
  ])
  const r = await runSpinLook(car.deps, 'natural')
  assert.equal(r.changed, 5)
  assert.equal(car.rows.get('e')!.image_url, 'https://elsewhere.example/x.jpg')
  const plan = (id: string) => /-v1-([0-9a-f]{8})\.jpg$/.exec(car.rows.get(id)!.image_url)![1]
  assert.equal(plan('a'), plan('b'))
  assert.equal(plan('c'), plan('d'))
  assert.notEqual(plan('a'), plan('c'), 'the high row has its own grade')
  assert.equal(car.log.at(-1), 'p:done:6')
})

// ── Back-fill of existing cars ──
import { spinsToBackfill, queueSpinLookBackfill, BACKFILL_FLAG, BACKFILL_PRIORITY } from '../utils/spinLookJob.js'

test('spinsToBackfill: main spins still on originals only; an owner choice and empty spins are left alone', () => {
  const o = (n: string) => `https://media.viewora.software/k/${n}.jpg`
  const f = (n: string) => `${o(n)}.studio-vivid-v1-deadbeef.jpg`
  const spins = [
    { id: 'a', space_id: 's1', row_of: null }, { id: 'a-high', space_id: 's1', row_of: 'a' },
    { id: 'b', space_id: 's2', row_of: null }, { id: 'c', space_id: 's3', row_of: null },
  ]
  const views = [
    { spin_id: 'a', image_url: o('1') }, { spin_id: 'a-high', image_url: o('2') },
    { spin_id: 'b', image_url: f('3') }, { spin_id: 'b', image_url: o('4') }, // owner chose vivid; a frame added since
  ]
  assert.deepEqual(spinsToBackfill(spins, views).map(s => s.id), ['a'])
})

test('queueSpinLookBackfill runs once, at low priority, and clears its flag when it fails', async () => {
  const flags = new Map<string, string>()
  const redis = {
    set: async (k: string, v: string) => (flags.has(k) ? null : (flags.set(k, v), 'OK')),
    setEx: async (k: string, _s: number, v: string) => { flags.set(k, v) },
    del: async (k: any) => { flags.delete(k) },
  }
  const added: any[] = []
  const queue = { add: async (name: string, data: any, opts: any) => { added.push({ name, data, opts }) } }
  const table = (rows: any[]) => ({ select: () => ({ in: async () => ({ data: rows, error: null }), then: (r: any) => r({ data: rows, error: null }) }) })
  const fastify: any = {
    log: { info() {}, error() {} },
    supabase: { from: (t: string) => t === 'vehicle_spins'
      ? table([{ id: 'a', space_id: 's1', row_of: null }])
      : table([{ spin_id: 'a', image_url: 'https://media.viewora.software/k/1.jpg' }]) },
  }
  assert.equal(await queueSpinLookBackfill(fastify, redis, queue), 1)
  assert.equal(added[0].data.look, 'natural')
  assert.equal(added[0].opts.priority, BACKFILL_PRIORITY)
  assert.equal(await queueSpinLookBackfill(fastify, redis, queue), 0, 'second start does nothing')
  assert.equal(added.length, 1)

  flags.clear()
  const broken: any = { log: fastify.log, supabase: { from: () => ({ select: () => ({ then: (r: any) => r({ data: null, error: { message: 'down' } }) }) }) } }
  assert.equal(await queueSpinLookBackfill(broken, redis, queue), 0)
  assert.equal(flags.has(BACKFILL_FLAG), false, 'flag cleared so the next start retries')
})
