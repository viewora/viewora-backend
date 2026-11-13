import test from 'node:test'
import assert from 'node:assert/strict'

import { recoverStuckScenes, isStuck, MAX_RECOVERIES, STUCK_AFTER_MS } from '../utils/sceneRecovery.js'

const NOW = Date.parse('2026-11-13T09:00:00Z')
const old = new Date(NOW - STUCK_AFTER_MS - 60_000).toISOString()
const fresh = new Date(NOW - 60_000).toISOString()

function fakeDb() {
  const updates: Array<{ id: string; patch: any }> = []
  const supabase = {
    from: () => ({
      update: (patch: any) => ({
        eq: (_col: string, id: string) => ({
          in: async () => { updates.push({ id, patch }); return { error: null } },
        }),
      }),
    }),
  }
  return { supabase, updates }
}

function fakeRedis() {
  const counts = new Map<string, number>()
  return {
    incr: async (k: string) => { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n },
    expire: async () => 1,
  }
}

const scene = (over: any = {}) => ({ id: 's1', space_id: 'sp1', raw_image_url: 'https://media.viewora.software/x.jpg', status: 'pending', updated_at: old, ...over })

test('only pending/processing scenes older than the cutoff count as stuck', () => {
  assert.equal(isStuck(scene(), NOW), true)
  assert.equal(isStuck(scene({ status: 'processing' }), NOW), true)
  assert.equal(isStuck(scene({ updated_at: fresh }), NOW), false)
  assert.equal(isStuck(scene({ status: 'ready' }), NOW), false)
  assert.equal(isStuck(scene({ status: 'failed' }), NOW), false)
})

test('a stuck scene is stamped pending and its tile job re-queued', async () => {
  const { supabase, updates } = fakeDb()
  const jobs: any[] = []
  const queue = { add: async (name: string, data: any) => { jobs.push({ name, data }) } }
  const res = await recoverStuckScenes([scene(), scene({ id: 's2', updated_at: fresh })], { sp1: 'u1' }, { supabase, queue, redis: fakeRedis(), now: NOW })
  assert.deepEqual(res, { requeued: 1, failed: 0 })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].name, 'tile-scene')
  assert.deepEqual(jobs[0].data, { sceneId: 's1', rawImageUrl: scene().raw_image_url, spaceId: 'sp1', userId: 'u1' })
  assert.equal(updates[0].patch.status, 'pending')
  assert.equal(updates[0].patch.updated_at, new Date(NOW).toISOString())
})

test('after the retry budget the scene is marked failed instead of re-queued again', async () => {
  const { supabase, updates } = fakeDb()
  const jobs: any[] = []
  const queue = { add: async (_n: string, data: any) => { jobs.push(data) } }
  const redis = fakeRedis()
  for (let i = 0; i < MAX_RECOVERIES; i++) await recoverStuckScenes([scene()], {}, { supabase, queue, redis, now: NOW })
  const last = await recoverStuckScenes([scene()], {}, { supabase, queue, redis, now: NOW })
  assert.equal(jobs.length, MAX_RECOVERIES)
  assert.deepEqual(last, { requeued: 0, failed: 1 })
  assert.equal(updates.at(-1)!.patch.status, 'failed')
})

test('a stuck scene with no photo is marked failed straight away', async () => {
  const { supabase, updates } = fakeDb()
  const res = await recoverStuckScenes([scene({ raw_image_url: null })], {}, { supabase, queue: { add: async () => {} }, now: NOW })
  assert.deepEqual(res, { requeued: 0, failed: 1 })
  assert.equal(updates[0].patch.status, 'failed')
})
