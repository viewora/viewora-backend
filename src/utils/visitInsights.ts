// What visitors did inside tours with guided visits, summed up for the owner's
// dashboard (GET /analytics/visits). Rows come from visit_events
// (migration-visit-events.sql). Pure: no database here, so it is tested on
// plain rows (src/tests/visitInsights.test.ts).
//
// Modelled on what hospital and campus tours report: visits and visitors
// (Alder Hey), stops viewed, completion and where people stop watching
// (YouVisit-style narrated tours), directions asked for (wayfinding maps),
// and the phone / desktop split.

export const VISIT_EVENTS = [
  'tour_open', 'session_end', 'scene_view',
  'visit_start', 'step_reached', 'visit_complete', 'visit_exit',
  'area_open', 'area_complete',
  'route_start', 'route_arrive',
] as const
export type VisitEventName = typeof VISIT_EVENTS[number]

export interface VisitEventRow {
  space_id: string
  visitor_id: string
  session_id: string
  event: string
  journey_id?: string | null
  scene_id?: string | null
  step?: number | null
  value?: number | null
  meta?: Record<string, unknown> | null
  created_at: string
}

export interface JourneyInfo { id: string; title: string; steps: { title: string }[] }

export interface VisitInsights {
  sessions: number
  visitors: number
  /** Typical time on the tour (median of session_end), ms; null without data. */
  medianSessionMs: number | null
  devices: { phone: number; tablet: number; desktop: number }
  /** Share of sessions that used a guided visit, an area guide or directions (0–1). */
  guidedShare: number
  daily: { date: string; sessions: number }[]
  visits: {
    journey_id: string
    title: string
    starts: number
    completes: number
    /** completes / starts (0–1). */
    completionRate: number
    /** Median time to finish, ms. */
    medianMs: number | null
    /** Per step: how many sessions got that far. */
    steps: { title: string; reached: number }[]
    /** The step most early leavers left at (null: nobody left early). */
    topExitStep: number | null
  }[]
  areas: { scene_id: string; title: string; opens: number; completes: number }[]
  scenes: { scene_id: string; title: string; views: number }[]
  routes: { from: string | null; to: string; fromTitle: string; toTitle: string; asks: number; arrived: number }[]
}

/**
 * What to call each photo: the first journey step's title on it ("Reception"),
 * as the tour's list of areas does (viewora-app tourAreas), else its own name.
 */
export function placeNames(
  scenes: { id: string; name?: string | null }[],
  journeys: { steps?: { title?: string; scene_id?: string | null }[] | null }[],
): Map<string, string> {
  const out = new Map(scenes.map(s => [s.id, (s.name ?? '').trim() || 'Untitled photo']))
  const named = new Set<string>()
  for (const j of journeys) {
    for (const st of Array.isArray(j.steps) ? j.steps : []) {
      const t = String(st?.title ?? '').trim()
      if (!st?.scene_id || !t || named.has(st.scene_id) || !out.has(st.scene_id)) continue
      named.add(st.scene_id)
      out.set(st.scene_id, t)
    }
  }
  return out
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

/** Counts each key once per session (Watch again or a reload doesn't double it). */
class PerSession {
  private seen = new Map<string, Set<string>>()
  add(key: string, session: string) {
    let s = this.seen.get(key)
    if (!s) this.seen.set(key, (s = new Set()))
    s.add(session)
  }
  count(key: string) { return this.seen.get(key)?.size ?? 0 }
  keys() { return [...this.seen.keys()] }
}

export function summarizeVisits(
  rows: VisitEventRow[],
  journeys: JourneyInfo[],
  sceneNames: Map<string, string>,
  days: number,
  now = new Date(),
): VisitInsights {
  const sessions = new Set<string>()
  const visitors = new Set<string>()
  const guided = new Set<string>()
  const devices = { phone: 0, tablet: 0, desktop: 0 }
  const sessionMs: number[] = []
  const perDay = new Map<string, Set<string>>()

  const starts = new PerSession()
  const completes = new PerSession()
  const reached = new PerSession()
  const finishMs = new Map<string, number[]>()
  // Furthest step each session reached in each visit, and whether it finished.
  const furthest = new Map<string, number>()
  const finished = new Set<string>()
  const exits = new Map<string, number>()

  const areaOpens = new PerSession()
  const areaDone = new PerSession()
  const sceneViews = new Map<string, number>()
  const routeAsks = new PerSession()
  const routeArrived = new PerSession()
  const routeOf = new Map<string, { from: string | null; to: string }>()
  // A route_arrive only counts for the route that session last asked for.
  const lastRoute = new Map<string, string>()

  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const r of ordered) {
    const s = r.session_id
    sessions.add(s)
    visitors.add(r.visitor_id)
    const day = r.created_at.slice(0, 10)
    let d = perDay.get(day)
    if (!d) perDay.set(day, (d = new Set()))
    d.add(s)

    switch (r.event) {
      case 'tour_open': {
        const dev = String(r.meta?.device ?? '')
        if (dev === 'phone' || dev === 'tablet' || dev === 'desktop') devices[dev]++
        break
      }
      case 'session_end':
        if (typeof r.value === 'number' && r.value > 0) sessionMs.push(r.value)
        break
      case 'scene_view':
        if (r.scene_id) sceneViews.set(r.scene_id, (sceneViews.get(r.scene_id) ?? 0) + 1)
        break
      case 'visit_start':
        if (r.journey_id) { starts.add(r.journey_id, s); guided.add(s) }
        break
      case 'step_reached':
        if (r.journey_id && typeof r.step === 'number') {
          reached.add(`${r.journey_id}:${r.step}`, s)
          const k = `${r.journey_id}:${s}`
          furthest.set(k, Math.max(furthest.get(k) ?? 0, r.step))
        }
        break
      case 'visit_complete':
        if (r.journey_id) {
          completes.add(r.journey_id, s)
          finished.add(`${r.journey_id}:${s}`)
          if (typeof r.value === 'number' && r.value > 0) {
            const xs = finishMs.get(r.journey_id) ?? []
            xs.push(r.value)
            finishMs.set(r.journey_id, xs)
          }
        }
        break
      case 'area_open':
        if (r.scene_id) { areaOpens.add(r.scene_id, s); guided.add(s) }
        break
      case 'area_complete':
        if (r.scene_id) areaDone.add(r.scene_id, s)
        break
      case 'route_start':
        if (r.scene_id) {
          const from = typeof r.meta?.from === 'string' ? r.meta.from : null
          const key = `${from ?? ''}>${r.scene_id}`
          routeOf.set(key, { from, to: r.scene_id })
          routeAsks.add(key, s)
          lastRoute.set(s, key)
          guided.add(s)
        }
        break
      case 'route_arrive': {
        const key = lastRoute.get(s)
        if (key && r.scene_id && routeOf.get(key)?.to === r.scene_id) routeArrived.add(key, s)
        break
      }
    }
  }

  // Where people who didn't finish stopped watching.
  for (const [k, step] of furthest) {
    if (finished.has(k)) continue
    const jid = k.slice(0, k.indexOf(':'))
    const ek = `${jid}:${step}`
    exits.set(ek, (exits.get(ek) ?? 0) + 1)
  }

  const nameOf = (id: string | null) => (id ? sceneNames.get(id) ?? 'A photo that was removed' : 'Where they were')

  const known = new Map(journeys.map(j => [j.id, j]))
  const journeyIds = new Set([...starts.keys(), ...journeys.map(j => j.id)])
  const visits = [...journeyIds].map((id) => {
    const j = known.get(id)
    const n = starts.count(id)
    const done = completes.count(id)
    const stepTitles = j?.steps.map((x, i) => x.title?.trim() || `Step ${i + 1}`) ?? []
    let topExitStep: number | null = null
    let topExits = 0
    for (let i = 0; i < stepTitles.length; i++) {
      const e = exits.get(`${id}:${i}`) ?? 0
      if (e > topExits) { topExits = e; topExitStep = i }
    }
    return {
      journey_id: id,
      title: j?.title ?? 'A visit that was removed',
      starts: n,
      completes: done,
      completionRate: n ? Math.min(1, done / n) : 0,
      medianMs: median(finishMs.get(id) ?? []),
      steps: stepTitles.map((title, i) => ({ title, reached: reached.count(`${id}:${i}`) })),
      topExitStep,
    }
  }).filter(v => v.starts > 0 || known.has(v.journey_id))
    .sort((a, b) => b.starts - a.starts)

  const areas = areaOpens.keys().map(id => ({
    scene_id: id, title: nameOf(id), opens: areaOpens.count(id), completes: areaDone.count(id),
  })).sort((a, b) => b.opens - a.opens)

  const scenes = [...sceneViews].map(([id, views]) => ({ scene_id: id, title: nameOf(id), views }))
    .sort((a, b) => b.views - a.views).slice(0, 10)

  const routes = routeAsks.keys().map((key) => {
    const r = routeOf.get(key)!
    return { from: r.from, to: r.to, fromTitle: nameOf(r.from), toTitle: nameOf(r.to), asks: routeAsks.count(key), arrived: routeArrived.count(key) }
  }).sort((a, b) => b.asks - a.asks).slice(0, 10)

  // Every day in the window, zeros included, so the chart has no gaps.
  const daily: { date: string; sessions: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10)
    daily.push({ date, sessions: perDay.get(date)?.size ?? 0 })
  }

  return {
    sessions: sessions.size,
    visitors: visitors.size,
    medianSessionMs: median(sessionMs),
    devices,
    guidedShare: sessions.size ? guided.size / sessions.size : 0,
    daily,
    visits,
    areas,
    scenes,
    routes,
  }
}
