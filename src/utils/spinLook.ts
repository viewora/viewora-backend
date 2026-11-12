// "Studio finish" for a car spin: the job that grades every frame of a spin (spinEnhance.ts) and
// points the spin at the finished copies, and the rules for naming and undoing them.
//
// The original files are never changed. Each finished copy is saved next to its original as
// `<original key>.studio-<look>-v<version>-<plan>.jpg`, so going back to the original is only a matter
// of pointing the photo at it again, and deleting the original finds its copies by that prefix. No
// database column is needed: a photo's look is read from its URL. <plan> is a fingerprint of the
// grade: media is cached for a year, so a re-graded spin (frames added since) needs new names, while
// a retried job finds its own copies and reuses them.

import { createHash } from 'node:crypto'
import { ENHANCE_VERSION, SPIN_LOOKS, enhanceFrame, frameGrade, measureFrame, planSpinGrade, type RestoreFn, type SpinLook } from './spinEnhance.js'

export type LookChoice = SpinLook | 'original'
export const LOOK_CHOICES: LookChoice[] = ['original', ...SPIN_LOOKS]

const SUFFIX = /\.studio-(natural|vivid|hd)-v(\d+)(?:-[0-9a-f]{8})?\.jpg$/

/** Prefix shared by every finished copy of an original. */
export const studioPrefix = (originalKey: string) => `${originalKey}.studio-`

/** The finished copy's key for an original key. */
export function studioKey(originalKey: string, look: SpinLook, plan: string, version = ENHANCE_VERSION): string {
  return `${studioPrefix(originalKey)}${look}-v${version}-${plan}.jpg`
}

/** Short fingerprint of a grade plan (8 hex characters). */
export function planId(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 8)
}

/** The original's key (or URL) for a finished copy's key (or URL); an original comes back as is. */
export function originalOf(keyOrUrl: string): string {
  return keyOrUrl.replace(SUFFIX, '')
}

/** The look a photo URL shows. */
export function lookOf(url: string): LookChoice {
  const m = SUFFIX.exec(url)
  return m ? (m[1] as SpinLook) : 'original'
}

/**
 * The storage key behind a media URL, or null when it is not on our media domain (a photo from
 * elsewhere is never fetched or written by the job).
 */
export function keyFromUrl(url: string, mediaDomain: string): string | null {
  try {
    const u = new URL(url)
    const base = new URL(mediaDomain)
    if (u.origin !== base.origin) return null
    const prefix = base.pathname.replace(/\/+$/, '')
    if (prefix && !u.pathname.startsWith(prefix + '/')) return null
    const key = decodeURIComponent(u.pathname.slice(prefix.length + 1))
    return key && !key.includes('..') ? key : null
  } catch {
    return null
  }
}

/** The key behind a URL on any of our media domains, and that domain (new copies are served from it too). */
export function keyFromAny(url: string, domains: string[]): { key: string; domain: string } | null {
  for (const d of domains) {
    if (!d) continue
    const key = keyFromUrl(url, d)
    if (key) return { key, domain: d.replace(/\/+$/, '') }
  }
  return null
}

/** What the editor shows: the spin's look, and how many photos are not on it (added since). */
export function spinLookSummary(urls: string[]): { look: LookChoice; behind: number } {
  if (!urls.length) return { look: 'original', behind: 0 }
  const counts = new Map<LookChoice, number>()
  for (const u of urls) counts.set(lookOf(u), (counts.get(lookOf(u)) ?? 0) + 1)
  // The look most photos have; photos added later are original and count as "behind".
  const enhanced = [...counts.entries()].filter(([l]) => l !== 'original').sort((a, b) => b[1] - a[1])[0]
  if (!enhanced) return { look: 'original', behind: 0 }
  return { look: enhanced[0], behind: urls.length - enhanced[1] }
}

export interface SpinLookProgress {
  state: 'queued' | 'working' | 'done' | 'failed'
  look: LookChoice
  done: number
  total: number
  error?: string
}

export const progressKey = (spinId: string) => `spin-look:${spinId}`

export interface SpinLookDeps {
  /**
   * The car's photos for this spin and its other camera heights. Each height (spin_id) gets its own
   * grade: a high row sees more of the bright ceiling, and that is not an exposure error.
   */
  frames: () => Promise<{ id: string; image_url: string; angle: number; spin_id: string }[]>
  read: (key: string) => Promise<Buffer>
  exists: (key: string) => Promise<boolean>
  write: (key: string, body: Buffer) => Promise<void>
  /** Points photos at new URLs, all together at the end. */
  setUrls: (rows: { id: string; image_url: string }[]) => Promise<void>
  /** Best-effort removal of finished copies no photo uses any more. */
  remove: (keys: string[]) => Promise<void>
  progress: (p: SpinLookProgress) => Promise<void>
  /** Our media domains (the configured one first). A photo on none of them is left alone. */
  mediaDomains: string[]
  /** AI restoration (needed for the 'hd' look). */
  restore?: RestoreFn
}

/**
 * Puts a spin on a look. The grade is planned from every frame of the spin, so all of them match;
 * nothing changes on screen until every copy is saved, then the spin switches over at once.
 * Safe to run again: finished copies that already exist are reused, not redone.
 */
export async function runSpinLook(deps: SpinLookDeps, look: LookChoice): Promise<{ changed: number }> {
  const frames = [...(await deps.frames())].sort((a, b) => a.angle - b.angle)
  const total = frames.length
  await deps.progress({ state: 'working', look, done: 0, total })

  const keyed = frames.map(f => {
    const hit = keyFromAny(originalOf(f.image_url), deps.mediaDomains)
    return { ...f, key: hit?.key ?? null, domain: hit?.domain ?? '' }
  })
  const base = (f: typeof keyed[number]) => originalOf(f.image_url)

  /** Copies the photos pointed at before, once they point elsewhere. */
  const stale = (rows: { id: string; image_url: string }[]) => {
    const now = new Map(rows.map(r => [r.id, r.image_url]))
    return keyed
      .filter(f => f.image_url !== base(f) && now.has(f.id) && now.get(f.id) !== f.image_url)
      .map(f => keyFromAny(f.image_url, deps.mediaDomains)?.key)
      .filter((k): k is string => !!k)
  }
  const tidy = async (keys: string[]) => { if (keys.length) await deps.remove(keys).catch(() => {}) }

  if (look === 'original') {
    const rows = keyed.filter(f => f.image_url !== base(f)).map(f => ({ id: f.id, image_url: base(f) }))
    if (rows.length) await deps.setUrls(rows)
    await tidy(stale(rows))
    await deps.progress({ state: 'done', look, done: total, total })
    return { changed: rows.length }
  }

  const rows: { id: string; image_url: string }[] = []
  let done = 0
  const heights = new Map<string, typeof keyed>()
  for (const f of keyed) {
    if (!f.key) { done++; continue } // not on our media domain: left as it is
    heights.set(f.spin_id, [...(heights.get(f.spin_id) ?? []), f])
  }
  for (const lap of heights.values()) {
    // 1. Measure every frame of this lap (small copies) and plan one grade for it.
    const originals = new Map<string, Buffer>()
    const stats = []
    for (const f of lap) {
      const buf = await deps.read(f.key!)
      originals.set(f.id, buf)
      stats.push(await measureFrame(buf))
    }
    const plan = planSpinGrade(stats, look)
    const pid = planId(plan)

    // 2. Save each finished copy (reusing one already saved by an earlier, interrupted run).
    //    AI HD waits on a GPU service, so several frames go at once; the local grade runs one by one.
    const lapRows: ({ id: string; image_url: string } | null)[] = new Array(lap.length).fill(null)
    let next = 0
    const one = async () => {
      while (next < lap.length) {
        const i = next++
        const f = lap[i]
        const outKey = studioKey(f.key!, look, pid)
        if (!(await deps.exists(outKey))) {
          const { buffer } = await enhanceFrame(originals.get(f.id)!, frameGrade(plan, i), look, deps.restore)
          await deps.write(outKey, buffer)
        }
        originals.delete(f.id)
        const url = `${f.domain}/${outKey.split('/').map(encodeURIComponent).join('/')}`
        if (url !== f.image_url) lapRows[i] = { id: f.id, image_url: url }
        await deps.progress({ state: 'working', look, done: ++done, total })
      }
    }
    await Promise.all(Array.from({ length: look === 'hd' ? 4 : 1 }, one))
    for (const r of lapRows) if (r) rows.push(r)
  }

  // 3. Switch the whole car over at once.
  if (rows.length) await deps.setUrls(rows)
  await tidy(stale(rows))
  await deps.progress({ state: 'done', look, done: total, total })
  return { changed: rows.length }
}
