import type { LocationAnswer, RateItem, RateTable } from './types.js'

// Travel zones are rate items with category 'travel'. Each carries
// meta.maxKm (distance from settings.origin) and meta.towns (names typed by
// visitors). The far zone has no maxKm and catches everything beyond. The
// per-diem rate and the "not placed yet" line are travel items too, but
// they aren't zones.

function travelZones(table: RateTable): RateItem[] {
  return Object.values(table.items)
    .filter(i => i.category === 'travel' && !i.meta?.perDiem && !i.meta?.placeholder)
    .sort((a, b) => (Number(a.meta?.maxKm ?? Infinity)) - (Number(b.meta?.maxKm ?? Infinity)))
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

// Returns the zone rate key, or null when the location can't be placed
// (staff then confirm travel).
export function resolveZone(location: LocationAnswer | undefined, table: RateTable): string | null {
  if (!location) return null
  const zones = travelZones(table)

  if (location.zone && table.items[location.zone]?.category === 'travel') return location.zone

  if (typeof location.lat === 'number' && typeof location.lng === 'number') {
    const km = distanceKm(table.settings.origin, { lat: location.lat, lng: location.lng })
    const zone = zones.find(z => km <= Number(z.meta?.maxKm ?? Infinity))
    return zone?.key ?? null
  }

  const town = location.town?.trim().toLowerCase()
  if (town) {
    for (const zone of zones) {
      const towns = (zone.meta?.towns as string[] | undefined) ?? []
      if (towns.some(t => town.includes(t.toLowerCase()))) return zone.key
    }
  }
  return null
}
