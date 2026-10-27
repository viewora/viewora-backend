// Industries on the form that have no pricing module yet. They use the
// "other" module (staff price them by hand) and are tagged industry:<key>.
export const PLANNED_INDUSTRIES = ['restaurants', 'developers', 'malls', 'institutions', 'farms'] as const

// Names staff see in alerts and the admin, the same as the form shows.
// (The form has its own translatable copy of these.)
const INDUSTRY_LABELS: Record<string, string> = {
  homes: 'Homes and real estate',
  airbnb: 'Airbnb and short-stay',
  hotels: 'Hotels and lodges',
  vehicles: 'Car dealers and hire',
  other: 'Something else',
  restaurants: 'Restaurants and venues',
  developers: 'Developers and land',
  malls: 'Malls and retail',
  institutions: 'Offices, schools and clinics',
  farms: 'Farms and factories',
}

export const CLIENT_TYPE_LABELS: Record<string, string> = {
  owner: 'Owner', agent: 'Agent', developer: 'Developer', manager: 'Manager',
  marketer: 'Marketing agency', other: 'Something else',
}

export const industryHint = (flags: string[]) => flags.find(f => f.startsWith('industry:'))?.slice('industry:'.length) ?? null

export function industryLabel(moduleKey: string | null | undefined, flags: string[], moduleLabel?: string): string {
  const key = industryHint(flags) ?? moduleKey
  return (key && INDUSTRY_LABELS[key]) || moduleLabel || 'Unknown'
}
