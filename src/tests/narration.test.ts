// Run with: npx tsx --test src/tests/narration.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import journeyRoutes from '../routes/journeys.js'
import { journeyLines, narrationHash, normalizeLine, withAudio } from '../utils/narration.js'

const JOURNEY_ID = '44444444-4444-4444-8444-444444444444'
const SPACE_ID = '11111111-1111-4111-8111-111111111111'

// Same vector as tts-worker/tests/test_narration.py: both sides must agree.
const VECTOR_TEXT = '  Register at the   front desk. '
const VECTOR_HASH = 'dad87f584876ad6b1309cb51f720512a4ac209d8b774e38338c994c195c61d2a'

test('lines are hashed on what is said: spacing does not matter, voice does', () => {
  assert.equal(normalizeLine(VECTOR_TEXT), 'Register at the front desk.')
  assert.equal(narrationHash(VECTOR_TEXT), narrationHash('Register at the front desk.'))
  assert.notEqual(narrationHash('Register at the front desk.', 'af_heart'), narrationHash('Register at the front desk.', 'bf_emma'))
  assert.notEqual(narrationHash('Register at the front desk.'), narrationHash('Register at the front desk!'))
})

test('hash vector shared with the Python worker', () => {
  assert.equal(narrationHash(VECTOR_TEXT, 'af_heart'), VECTOR_HASH)
})

const steps = [
  { sentences: [{ id: 'a', text: 'Welcome.' }, { id: 'b', text: '  ' }, { id: 'c', text: 'Park on the left.' }] },
  { sentences: [{ id: 'd', text: 'Welcome. ' }, { id: 'e', text: 'Pay here.' }] },
]

test('a journey needs one recording per distinct non-empty line', () => {
  assert.deepEqual(journeyLines(steps).map(l => l.text), ['Welcome.', 'Park on the left.', 'Pay here.'])
  assert.deepEqual(journeyLines(null), [])
})

function stub(rows: { audio?: any[]; journey?: any; active?: any }, writes: any[] = []) {
  return {
    from(table: string) {
      let op = 'select'
      const b: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) b[m] = () => b
      for (const m of ['insert', 'update']) b[m] = (row?: any) => { op = m; writes.push({ table, op, row }); return b }
      const result = () => {
        if (table === 'subscriptions') return { data: null, error: { message: 'none' } } // free plan
        if (table === 'plans') return { data: { slug: 'free', max_active_properties: 3 }, error: null }
        if (table === 'narration_audio') return { data: rows.audio ?? [], error: null }
        if (table === 'journeys' && op === 'select') return { data: rows.journey, error: null }
        if (table === 'narration_jobs' && op === 'insert') return { data: { id: 'job-1', ...writes.at(-1).row, status: 'queued' }, error: null }
        if (table === 'narration_jobs') return { data: rows.active ?? null, error: null }
        return { data: { id: JOURNEY_ID, space_id: SPACE_ID }, error: null } // ownership
      }
      b.single = async () => result()
      b.maybeSingle = async () => result()
      b.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
      return b
    },
  }
}

async function app(supabase: any) {
  const a = Fastify()
  a.decorate('authenticate', async (req: any) => { req.user = { sub: 'user-1' } })
  a.decorate('supabase', supabase)
  a.decorate('redis', null as any)
  await a.register(journeyRoutes)
  return a
}

const recorded = (text: string) => ({ hash: narrationHash(text), url: `https://cdn/narration/${narrationHash(text)}.mp3`, duration_ms: 1200 })

test('withAudio gives recorded lines their file and leaves the rest as captions', async () => {
  const fake: any = { supabase: stub({ audio: [recorded('Welcome.')] }) }
  const [j] = await withAudio(fake, [{ steps, narration_voice: 'af_heart' }])
  const s0 = (j as any).steps[0].sentences
  assert.equal(s0[0].audio.url, recorded('Welcome.').url)
  assert.equal(s0[0].audio.text, 'Welcome.')
  assert.equal(s0[2].audio, undefined)
  assert.equal((j as any).steps[1].sentences[0].audio.duration_ms, 1200) // same sentence, shared file
})

async function post(rows: any, body: any = {}) {
  const writes: any[] = []
  const a = await app(stub(rows, writes))
  const res = await a.inject({ method: 'POST', url: `/journeys/${JOURNEY_ID}/narration`, payload: body, headers: { authorization: 'Bearer t' } })
  return { res, jobs: writes.filter(w => w.table === 'narration_jobs' && w.op === 'insert') }
}

test('generate: only lines without a recording are queued, in one job', async () => {
  const { res, jobs } = await post({ journey: { steps, narration_voice: 'af_heart' }, audio: [recorded('Welcome.')] })
  assert.equal(res.statusCode, 202)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].row.total, 2)
  assert.equal(res.json().voiced, 1)
})

test('generate: nothing to record means no job and no wake-up', async () => {
  const all = ['Welcome.', 'Park on the left.', 'Pay here.'].map(recorded)
  const { res, jobs } = await post({ journey: { steps }, audio: all })
  assert.equal(res.statusCode, 200)
  assert.equal(jobs.length, 0)
  assert.equal(res.json().job, null)
})

test('generate: force re-records every line; a running job is reused', async () => {
  const all = ['Welcome.', 'Park on the left.', 'Pay here.'].map(recorded)
  const forced = await post({ journey: { steps }, audio: all }, { force: true })
  assert.equal(forced.jobs[0].row.total, 3)
  const again = await post({ journey: { steps }, audio: [], active: { id: 'job-0', status: 'running' } })
  assert.equal(again.jobs.length, 0)
  assert.equal(again.res.json().job.id, 'job-0')
})
