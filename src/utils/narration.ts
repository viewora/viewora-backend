// Recorded narration for journeys: one short MP3 per line, made by the Kokoro
// worker (tts-worker/), looked up by a hash of the line and the voice.
//
// The hash must match tts-worker/narration.py exactly; both test the same
// vector (src/tests/narration.test.ts, tts-worker/tests/test_narration.py).
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

export const NARRATION_MODEL = 'kokoro-82m-v1.0'
export const DEFAULT_VOICE = 'af_heart'
/** Voices a journey can use: exactly the ones baked into the worker image.
 *  Same list in tts-worker/narration.py and the app; tts-worker/tests/test_voices.py checks. */
export const VOICES = ['af_heart', 'af_bella', 'bf_emma', 'am_michael'] as const
/** Speaking speed, as text so both languages hash the same characters. */
export const NARRATION_SPEED = '1.0'

/** What is actually said: trimmed, runs of whitespace as one space. */
export function normalizeLine(text: string): string {
  return String(text ?? '').trim().replace(/\s+/g, ' ')
}

export function narrationHash(text: string, voice: string = DEFAULT_VOICE): string {
  return createHash('sha256')
    .update(`${NARRATION_MODEL}\n${voice}\n${NARRATION_SPEED}\n${normalizeLine(text)}`)
    .digest('hex')
}

export interface NarrationLine { hash: string; text: string }

/** Every distinct non-empty line of a journey, in order. */
export function journeyLines(steps: unknown, voice: string = DEFAULT_VOICE): NarrationLine[] {
  const out: NarrationLine[] = []
  const seen = new Set<string>()
  for (const s of Array.isArray(steps) ? steps : []) {
    for (const x of Array.isArray((s as any)?.sentences) ? (s as any).sentences : []) {
      const text = normalizeLine(x?.text ?? '')
      if (!text) continue
      const hash = narrationHash(text, voice)
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({ hash, text })
    }
  }
  return out
}

export interface AudioRow { hash: string; url: string; duration_ms: number }

/** The recordings that exist for these hashes. Empty when the table isn't there yet. */
export async function audioFor(fastify: FastifyInstance, hashes: string[]): Promise<Map<string, AudioRow>> {
  const found = new Map<string, AudioRow>()
  const unique = [...new Set(hashes)]
  for (let i = 0; i < unique.length; i += 150) {
    const { data, error } = await fastify.supabase
      .from('narration_audio').select('hash, url, duration_ms').in('hash', unique.slice(i, i + 150))
    if (error || !data) return found
    for (const r of data as AudioRow[]) found.set(r.hash, r)
  }
  return found
}

/**
 * Adds `audio: { url, duration_ms, text }` to each line that has a recording.
 * `text` is what was recorded, so the editor can tell when a line has been
 * edited since (the recording then no longer matches and isn't played).
 */
export async function withAudio<T extends { steps: any; narration_voice?: string | null }>(
  fastify: FastifyInstance, journeys: T[],
): Promise<T[]> {
  const hashes: string[] = []
  for (const j of journeys) for (const l of journeyLines(j.steps, j.narration_voice || DEFAULT_VOICE)) hashes.push(l.hash)
  if (!hashes.length) return journeys
  const audio = await audioFor(fastify, hashes)
  if (!audio.size) return journeys
  return journeys.map(j => {
    const voice = j.narration_voice || DEFAULT_VOICE
    const steps = (Array.isArray(j.steps) ? j.steps : []).map((s: any) => ({
      ...s,
      sentences: (Array.isArray(s?.sentences) ? s.sentences : []).map((x: any) => {
        const text = normalizeLine(x?.text ?? '')
        const a = text ? audio.get(narrationHash(text, voice)) : undefined
        return a ? { ...x, audio: { url: a.url, duration_ms: a.duration_ms, text } } : x
      }),
    }))
    return { ...j, steps }
  })
}

/**
 * Wake the TTS worker (Railway App Sleeping: private-network traffic wakes it).
 * The first request to a sleeping service can fail with a 502 while it boots,
 * so retry a few times. Never throws: the job is on the to-do list either way,
 * and the worker clears the whole list whenever it starts.
 */
export function wakeNarrationWorker(fastify: FastifyInstance): boolean {
  const base = process.env.TTS_WORKER_URL?.replace(/\/$/, '')
  if (!base) return false
  const delays = [0, 3000, 10000, 30000]
  void (async () => {
    for (const d of delays) {
      if (d) await new Promise(r => setTimeout(r, d))
      try {
        const res = await fetch(`${base}/wake`, { method: 'POST', signal: AbortSignal.timeout(15000) })
        if (res.ok) return
        fastify.log.warn({ status: res.status }, 'TTS worker wake: not ready yet')
      } catch (err: any) {
        fastify.log.warn({ err: err?.message }, 'TTS worker wake failed')
      }
    }
    // Gave up: almost always a wrong TTS_WORKER_URL or the worker isn't deployed.
    // The job stays queued and is recorded whenever the worker next starts.
    fastify.log.error({ url: `${base}/wake` }, 'TTS worker unreachable: check TTS_WORKER_URL (http://<private domain>:<PORT>) and that the worker is deployed')
  })()
  return true
}
