// Industries on the form that have no pricing module yet. They use the
// "other" module (staff price them by hand) and are tagged industry:<key>.
export const PLANNED_INDUSTRIES = ['restaurants', 'developers', 'malls', 'institutions', 'farms'] as const

// Names staff see in alerts; the form has its own (translatable) strings.
const PLANNED_LABELS: Record<string, string> = {
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

export function industryLabel(moduleLabel: string | undefined, flags: string[]): string {
  const hint = industryHint(flags)
  return (hint && PLANNED_LABELS[hint]) || moduleLabel || 'Unknown'
}
