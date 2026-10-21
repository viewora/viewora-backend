// Industry context for every AI feature. Viewora tours are not only homes for
// sale — hotels, schools, offices, dealerships, land, gyms, restaurants,
// churches, venues… The model has to know who the tour is for and what that
// audience cares about, or every scene reads like a real-estate listing.

export type Industry = {
  label:     string
  audience:  string   // who watches the tour
  goal:      string   // what the tour should help them decide
  highlight: string   // what is worth pointing out
  avoid:     string   // what is wrong for this industry
}

export const INDUSTRIES: Record<string, Industry> = {
  residential: {
    label:     'Residential property (house, apartment, maisonette — for sale or rent)',
    audience:  'home buyers and tenants',
    goal:      'picture living there and decide whether to book a viewing',
    highlight: 'layout and flow, natural light, storage, kitchen and bathroom finishes, outdoor space, parking, views',
    avoid:     'hotel or office language; guessing prices, security or water supply',
  },
  commercial: {
    label:     'Commercial space (office, shop, warehouse, co-working, retail)',
    audience:  'businesses looking to lease or buy space, and their customers',
    goal:      'judge whether the space fits their team or operation',
    highlight: 'usable floor space, natural light, meeting rooms, reception, power and data points, loading access, frontage, parking',
    avoid:     'homely language ("cosy bedroom"); inventing capacities or square footage',
  },
  hospitality: {
    label:     'Hospitality (hotel, lodge, guest house, Airbnb, restaurant, bar, event venue)',
    audience:  'guests, diners and event planners',
    goal:      'feel what a stay, meal or event there is like and decide to book',
    highlight: 'room comfort, bed type, en-suite, views, pool, dining areas, bar, ambience, event and conference spaces',
    avoid:     'selling the property as real estate (no "buyers", "investment"); inventing star ratings or prices',
  },
  education: {
    label:     'Education (school, college, university, training centre, daycare)',
    audience:  'parents, prospective students and staff',
    goal:      'trust the learning environment and decide to visit or enrol',
    highlight: 'classrooms, labs, library, ICT rooms, sports facilities, dining hall, boarding, safety and open space',
    avoid:     'sales or rental language; inventing student numbers, rankings or results',
  },
  automotive: {
    label:     'Automotive (car dealership, showroom, garage, or an individual vehicle interior/exterior)',
    audience:  'car buyers and service customers',
    goal:      'inspect the vehicle or showroom remotely and decide to visit or enquire',
    highlight: 'dashboard, seats and upholstery, infotainment, boot space, wheels, paint condition, showroom stock, service bays',
    avoid:     'room and property language ("bedroom", "living area"); inventing mileage, engine specs or prices',
  },
  land: {
    label:     'Land (plots, farms, estates, development sites)',
    audience:  'land buyers and investors',
    goal:      'understand the terrain, access and surroundings before a site visit',
    highlight: 'access road, beacons and boundaries, terrain and soil, vegetation, neighbouring developments, views, utilities visible on site',
    avoid:     'indoor room language; inventing acreage, title status or distances',
  },
  other: {
    label:     'Other business or venue (gym, church, clinic, museum, salon, factory, event space…) — infer the exact type from the tour name and photos',
    audience:  'that business\'s customers or visitors',
    goal:      'understand the place and decide to visit, join, book or enquire',
    highlight: 'whatever this specific kind of place is chosen for (equipment for a gym, seating for a church, treatment rooms for a clinic…)',
    avoid:     'defaulting to real-estate language when the place is a business',
  },
}

export function industryFor(spaceType: string | null | undefined): Industry {
  return INDUSTRIES[spaceType || 'other'] || INDUSTRIES.other
}

/** Block of text injected into every AI prompt. */
export function industryBrief(spaceType: string | null | undefined, title?: string | null): string {
  const ind = industryFor(spaceType)
  return [
    '<industry>',
    `Tour${title ? ` "${title}"` : ''} — ${ind.label}.`,
    `Viewers: ${ind.audience}. The tour should help them ${ind.goal}.`,
    `Worth pointing out: ${ind.highlight}.`,
    `Avoid: ${ind.avoid}.`,
    'Write labels and descriptions for THESE viewers, in this industry\'s own vocabulary.',
    '</industry>',
  ].join('\n')
}
