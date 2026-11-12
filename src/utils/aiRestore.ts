// AI restoration for car frames: Real-ESRGAN (open source, BSD-3) run on a GPU by Replicate.
// It removes video compression blotches and rebuilds clean edges, which no grade can do.
// Needs REPLICATE_API_TOKEN (API and worker). Cost is about $0.001-0.002 a frame.

import type { RestoreFn } from './spinEnhance.js'

const API = 'https://api.replicate.com/v1'
/** Override with REPLICATE_RESTORE_MODEL (owner/name) to try another restoration model. */
const MODEL = () => process.env.REPLICATE_RESTORE_MODEL || 'nightmareai/real-esrgan'

export const aiRestoreAvailable = () => !!process.env.REPLICATE_API_TOKEN

let versionCache: { model: string; id: string } | null = null

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 90_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${(body?.detail ?? body?.title ?? '').toString().slice(0, 200)}`)
  return body
}

async function modelVersion(): Promise<string> {
  const model = MODEL()
  if (versionCache?.model === model) return versionCache.id
  const m = await call(`/models/${model}`)
  const id = m?.latest_version?.id
  if (!id) throw new Error(`No version found for ${model}`)
  versionCache = { model, id }
  return id
}

/** Restores one JPEG (2x). Retries once on a failed or slow prediction. */
export function replicateRestore(): RestoreFn {
  return async (jpeg: Buffer) => {
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const version = await modelVersion()
        let p = await call('/predictions', {
          method: 'POST',
          headers: { Prefer: 'wait=55' },
          body: JSON.stringify({ version, input: { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, scale: 2, face_enhance: false } }),
        })
        const deadline = Date.now() + 4 * 60_000
        while (p.status !== 'succeeded') {
          if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Restore ${p.status}: ${String(p.error ?? '').slice(0, 200)}`)
          if (Date.now() > deadline) throw new Error('Restore timed out')
          await new Promise(r => setTimeout(r, 1500))
          p = await call(p.urls.get)
        }
        const url = Array.isArray(p.output) ? p.output[0] : p.output
        const img = await fetch(url, { signal: AbortSignal.timeout(60_000) })
        if (!img.ok) throw new Error(`Restored image download failed: ${img.status}`)
        return Buffer.from(await img.arrayBuffer())
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }
}
