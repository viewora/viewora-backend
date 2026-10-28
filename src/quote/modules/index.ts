// Industry modules. Each is plain config: its questions, which answers
// drive the price (by pointing at rate table keys) and its result mode.
// Add an industry by adding a module here — the engine needs no changes.
// Question text is the English default; the form's strings file can
// override it per locale using `quote.modules.<module>.<question>`.

import type { ChoiceOption, IndustryModule, Question, RateTable } from '../engine/types.js'

const homeSizes: ChoiceOption[] = [
  { value: 'studio', label: 'Studio / bedsitter', rateKey: 'home_studio' },
  { value: '1br', label: '1 bedroom', rateKey: 'home_1br' },
  { value: '2br', label: '2 bedrooms', rateKey: 'home_2br' },
  { value: '3br', label: '3 bedrooms / townhouse', rateKey: 'home_3br' },
  { value: 'villa', label: '4-5 bedroom villa / maisonette', rateKey: 'home_villa' },
  { value: 'mansion', label: '6+ bedroom mansion', rateKey: 'home_mansion' },
]

const homeAddons = [
  'extra_scene_home', 'video', 'reel', 'photos_20', 'hotspot_pack', 'branding', 'website_embed',
  'google_maps', 'floorplan_home_redraw', 'floorplan_home_draw', 'floorplan_home_measured',
  'rush', 'extra_revision',
]

const businessAddons = [
  'extra_scene_business', 'video', 'reel', 'photos_20', 'hotspot_pack', 'branding', 'website_embed',
  'google_maps', 'floorplan_biz_redraw', 'floorplan_biz_draw', 'floorplan_biz_measured',
  'rush', 'extra_revision',
]

export const homes: IndustryModule = {
  key: 'homes',
  version: 1,
  label: 'Homes',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'size', type: 'choice', label: 'What size is the home?', required: true, drivesPrice: true,
      options: [...homeSizes, { value: 'estate', label: 'Gated estate / multi-unit compound', rateKey: 'home_estate' }] },
    { id: 'purpose', type: 'choice', label: 'Is it for sale?', required: true, drivesPrice: true, default: 'let',
      options: [{ value: 'let', label: 'No, to let or to live in' }, { value: 'sale', label: 'Yes, for sale' }] },
    { id: 'listings', type: 'number', label: 'How many listings in this order?', help: 'Packs of 5, 10 or 20+ listings cost less per home.',
      min: 1, max: 200, default: 1, drivesPrice: true, clientTypes: ['agent', 'manager', 'developer', 'marketer'] },
    { id: 'same_building', type: 'number', label: 'How many of them are in the same building?', min: 1, max: 200, default: 1,
      drivesPrice: true, clientTypes: ['agent', 'manager', 'developer', 'marketer'] },
  ],
  pricing: {
    sector: 'home',
    base: { from: ['size'] },
    quantity: { question: 'listings' },
    uplifts: [{ rateKey: 'sale_uplift', when: { question: 'purpose', in: ['sale'] } }],
    discounts: [
      { rule: 'pack', question: 'listings', ladder: [{ min: 5, rateKey: 'pack_5' }, { min: 10, rateKey: 'pack_10' }, { min: 20, rateKey: 'pack_20' }] },
      { rule: 'per_unit', question: 'same_building', ladder: [{ min: 2, rateKey: 'same_building_2_5' }, { min: 6, rateKey: 'same_building_6' }] },
    ],
    addons: homeAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_home',
  },
}

export const airbnb: IndustryModule = {
  key: 'airbnb',
  version: 1,
  label: 'Airbnb and short-stay',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'size', type: 'choice', label: 'What size is the unit?', required: true, drivesPrice: true, options: homeSizes },
    { id: 'units', type: 'number', label: 'How many units should we shoot?', help: 'Extra units in the same building cost less.',
      min: 1, max: 100, default: 1, drivesPrice: true },
  ],
  pricing: {
    sector: 'home',
    base: { from: ['size'] },
    quantity: { question: 'units' },
    discounts: [
      { rule: 'per_unit', question: 'units', ladder: [{ min: 2, rateKey: 'same_building_2_5' }, { min: 6, rateKey: 'same_building_6' }] },
    ],
    addons: [...homeAddons, 'airbnb_pro_pack'],
    premiumAddons: ['video', 'airbnb_pro_pack'],
    hostingKey: 'hosting_home',
  },
}

export const hotels: IndustryModule = {
  key: 'hotels',
  version: 1,
  label: 'Hotels and lodges',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What kind of place is it?', required: true, drivesPrice: true,
      options: [
        { value: 'guesthouse', label: 'Guesthouse / B&B, up to 8 rooms', rateKey: 'hotel_guesthouse' },
        { value: 'hotel', label: 'Hotel' },
        { value: 'safari', label: 'Safari camp / resort' },
      ] },
    { id: 'rooms_hotel', type: 'choice', label: 'How many rooms?', required: true, drivesPrice: true,
      help: 'We shoot each room type plus the public areas, not every room.',
      showIf: { question: 'kind', in: ['hotel'] },
      options: [
        { value: '10', label: 'Up to 10', rateKey: 'hotel_10' },
        { value: '25', label: '11-25', rateKey: 'hotel_25' },
        { value: '50', label: '26-50', rateKey: 'hotel_50' },
        { value: '100', label: '51-100', rateKey: 'hotel_100' },
        { value: '200', label: '101-200', rateKey: 'hotel_200' },
        { value: '200plus', label: 'More than 200', rateKey: 'hotel_200plus' },
      ] },
    { id: 'rooms_safari', type: 'choice', label: 'How many tents or rooms?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['safari'] },
      options: [
        { value: '15', label: 'Up to 15', rateKey: 'safari_15' },
        { value: '40', label: '16-40', rateKey: 'safari_40' },
        { value: '40plus', label: 'More than 40', rateKey: 'safari_40plus' },
      ] },
  ],
  pricing: {
    sector: 'business',
    base: { from: ['rooms_hotel', 'rooms_safari', 'kind'] },
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

// Showrooms, car hire and garages.
export const vehicles: IndustryModule = {
  key: 'vehicles',
  version: 1,
  label: 'Vehicles',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What do you run?', required: true, drivesPrice: true,
      options: [
        { value: 'showroom', label: 'Car showroom or used-car yard' },
        { value: 'car_hire', label: 'Car hire' },
        { value: 'garage', label: 'Garage / car wash', rateKey: 'garage' },
      ] },
    { id: 'showroom_size', type: 'choice', label: 'How big is the showroom?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['showroom'] },
      options: [
        { value: '10', label: 'Up to 10 vehicles', rateKey: 'showroom_10' },
        { value: '30', label: 'Up to 30 vehicles', rateKey: 'showroom_30' },
      ] },
    { id: 'vehicles', type: 'number', label: 'How many vehicles should get an interior 360?', min: 0, max: 500, default: 0,
      drivesPrice: true, required: true, showIf: { question: 'kind', in: ['showroom', 'car_hire'] } },
  ],
  pricing: {
    sector: 'business',
    base: { from: ['showroom_size', 'kind'] },
    perUnit: [
      { question: 'vehicles', rateKey: 'vehicle_spin', when: { question: 'kind', in: ['showroom'] } },
      { question: 'vehicles', rateKey: 'car_hire_vehicle', when: { question: 'kind', in: ['car_hire'] } },
    ],
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

export const other: IndustryModule = {
  key: 'other',
  version: 1,
  label: 'Something else',
  enabled: true,
  resultMode: 'custom',
  flagNewIndustry: true,
  questions: [
    { id: 'description', type: 'text', label: 'What should we shoot?', help: 'A sentence is enough, for example "a dental clinic on two floors".', required: true },
    { id: 'setting', type: 'choice', label: 'Indoors or outdoors?', default: 'indoors',
      options: [{ value: 'indoors', label: 'Indoors' }, { value: 'outdoors', label: 'Outdoors' }, { value: 'both', label: 'Both' }] },
    { id: 'areas', type: 'number', label: 'Roughly how many rooms or areas?', help: 'Each room or area is about one 360° scene.',
      min: 1, max: 500, required: true, drivesPrice: true },
    { id: 'floors', type: 'number', label: 'How many floors?', min: 1, max: 100, default: 1 },
    { id: 'link', type: 'text', label: 'A link or photo that shows the place (optional)' },
  ],
  pricing: {
    sector: 'business',
    perScene: { question: 'areas', rateKey: 'scene_business' },
    addons: businessAddons,
    premiumAddons: [],
    hostingKey: 'hosting_business',
  },
}

// "When can we shoot?" for places that are busy in the day. The uplift
// amount lives in the rate table (night_uplift), not in the wording.
const shootTime: Question = {
  id: 'shoot_time', type: 'choice', label: 'When can we shoot?', drivesPrice: true, default: 'open',
  help: 'Shoots before opening or after closing cost a little more.',
  options: [{ value: 'open', label: 'During the day, while open' }, { value: 'night', label: 'Before opening or after closing' }],
}

export const restaurants: IndustryModule = {
  key: 'restaurants',
  version: 1,
  label: 'Restaurants and venues',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What kind of place is it?', required: true, drivesPrice: true,
      options: [
        { value: 'cafe', label: 'Café', rateKey: 'cafe' },
        { value: 'restaurant', label: 'Restaurant or bar', rateKey: 'restaurant' },
        { value: 'restaurant_large', label: 'Multi-level, rooftop or large outdoor restaurant', rateKey: 'restaurant_large' },
        { value: 'venue', label: 'Event venue' },
        { value: 'nightlife', label: 'Nightclub, lounge, cinema or bowling', rateKey: 'nightlife' },
      ] },
    { id: 'guests', type: 'choice', label: 'How many guests does it hold?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['venue'] },
      options: [
        { value: '100', label: 'Up to 100', rateKey: 'venue_100' },
        { value: '300', label: '100 to 300', rateKey: 'venue_300' },
        { value: '300plus', label: 'More than 300, or several halls', rateKey: 'venue_300plus' },
      ] },
    shootTime,
  ],
  pricing: {
    sector: 'business',
    base: { from: ['guests', 'kind'] },
    uplifts: [{ rateKey: 'night_uplift', when: { question: 'shoot_time', in: ['night'] } }],
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

// Developers, land, hostels and space to let. Land has no minimum job
// price: the rate card prices a single plot below it (Peter, 2026-10-28).
export const developers: IndustryModule = {
  key: 'developers',
  version: 1,
  label: 'Developers and land',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What should we shoot?', required: true, drivesPrice: true,
      options: [
        { value: 'show_unit', label: 'One show unit', rateKey: 'dev_show_unit' },
        { value: 'show_unit_plus', label: 'Show unit, amenities and outside', rateKey: 'dev_show_unit_plus' },
        { value: 'block', label: 'Whole apartment block: amenities and one show unit', rateKey: 'dev_block' },
        { value: 'full', label: 'Full development tour', rateKey: 'dev_full' },
        { value: 'progress', label: 'Construction progress, per site visit' },
        { value: 'commercial', label: 'Commercial space to let' },
        { value: 'hostel', label: 'Student hostel or co-living' },
        { value: 'land', label: 'Land or plots' },
        { value: 'memorial', label: 'Memorial park', rateKey: 'memorial_park' },
      ] },
    { id: 'hostel_rooms', type: 'choice', label: 'How many rooms?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['hostel'] },
      options: [
        { value: '20', label: 'Up to 20', rateKey: 'hostel_20' },
        { value: '60', label: '21 to 60', rateKey: 'hostel_60' },
        { value: '60plus', label: 'More than 60', rateKey: 'hostel_60plus' },
      ] },
    { id: 'land_size', type: 'choice', label: 'How big is the land?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['land'] },
      options: [
        { value: 'plot', label: 'One plot (50 × 100 ft)', rateKey: 'land_plot', noMinimum: true },
        { value: 'half_acre', label: 'Several plots, up to ½ acre', rateKey: 'land_half_acre', noMinimum: true },
        { value: '1_acre', label: '½ to 1 acre', rateKey: 'land_1_acre', noMinimum: true },
        { value: '5_acres', label: '1 to 5 acres', rateKey: 'land_5_acres', noMinimum: true },
        { value: '20_acres', label: '5 to 20 acres', rateKey: 'land_20_acres', noMinimum: true },
        { value: '50_acres', label: '20 to 50 acres', rateKey: 'land_50_acres', noMinimum: true },
        { value: '50plus', label: 'More than 50 acres', rateKey: 'land_50plus' },
      ] },
    { id: 'visits', type: 'number', label: 'How many site visits?', help: 'For example one a month until handover.',
      min: 1, max: 60, default: 1, required: true, drivesPrice: true, showIf: { question: 'kind', in: ['progress'] } },
    { id: 'units', type: 'number', label: 'How many units to let?', min: 1, max: 200, default: 1, required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['commercial'] } },
  ],
  pricing: {
    sector: 'business',
    base: { from: ['hostel_rooms', 'land_size', 'kind'] },
    perUnit: [
      { question: 'visits', rateKey: 'dev_progress', when: { question: 'kind', in: ['progress'] } },
      { question: 'units', rateKey: 'commercial_let', when: { question: 'kind', in: ['commercial'] } },
    ],
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

export const malls: IndustryModule = {
  key: 'malls',
  version: 1,
  label: 'Malls and retail',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What kind of place is it?', required: true, drivesPrice: true,
      options: [
        { value: 'mall', label: 'Shopping mall' },
        { value: 'shop', label: 'Shop or boutique', rateKey: 'shop' },
        { value: 'fashion', label: 'Fashion flagship store', rateKey: 'fashion_flagship' },
        { value: 'supermarket', label: 'Supermarket or large store', rateKey: 'supermarket' },
        { value: 'showroom', label: 'Furniture or appliance showroom', rateKey: 'showroom_furniture' },
        { value: 'salon', label: 'Salon or barber', rateKey: 'salon' },
        { value: 'gym', label: 'Gym or spa', rateKey: 'gym_spa' },
        { value: 'popup', label: 'Pop-up or temporary space', rateKey: 'popup' },
      ] },
    { id: 'mall_size', type: 'choice', label: 'How big is the mall?', required: true, drivesPrice: true,
      help: 'This covers the common areas: entrances, walkways, food court and parking.',
      showIf: { question: 'kind', in: ['mall'] },
      options: [
        { value: 'arcade', label: 'Arcade or neighbourhood centre', rateKey: 'mall_arcade' },
        { value: 'community', label: 'Community mall', rateKey: 'mall_community' },
        { value: 'regional', label: 'Regional mall', rateKey: 'mall_regional' },
        { value: 'super', label: 'Super-regional mall', rateKey: 'mall_super' },
      ] },
    { id: 'tenants', type: 'number', label: 'How many tenant shops should we shoot on the same visit?', min: 0, max: 500, default: 0,
      drivesPrice: true, showIf: { question: 'kind', in: ['mall'] } },
    { id: 'anchors', type: 'number', label: 'How many anchor tenants, like a supermarket or cinema?', help: 'We price these with you.',
      min: 0, max: 20, default: 0, drivesPrice: true, showIf: { question: 'kind', in: ['mall'] } },
    shootTime,
  ],
  pricing: {
    sector: 'business',
    base: { from: ['mall_size', 'kind'] },
    perUnit: [
      { question: 'tenants', rateKey: 'mall_tenant', when: { question: 'kind', in: ['mall'] } },
      { question: 'anchors', rateKey: 'mall_anchor', when: { question: 'kind', in: ['mall'] } },
    ],
    uplifts: [{ rateKey: 'night_uplift', when: { question: 'shoot_time', in: ['night'] } }],
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

export const institutions: IndustryModule = {
  key: 'institutions',
  version: 1,
  label: 'Offices, schools and clinics',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What kind of place is it?', required: true, drivesPrice: true,
      options: [
        { value: 'office', label: 'Office' },
        { value: 'coworking', label: 'Co-working space', rateKey: 'coworking' },
        { value: 'school', label: 'School, college or university' },
        { value: 'clinic', label: 'Clinic or dental practice', rateKey: 'clinic' },
        { value: 'vet', label: 'Vet clinic', rateKey: 'vet_clinic' },
        { value: 'pharmacy', label: 'Pharmacy', rateKey: 'pharmacy' },
        { value: 'lab', label: 'Diagnostic lab', rateKey: 'lab' },
        { value: 'hospital', label: 'Hospital' },
        { value: 'museum', label: 'Museum, gallery or heritage site', rateKey: 'museum' },
        { value: 'government', label: 'Government or county project', rateKey: 'government' },
      ] },
    { id: 'desks', type: 'choice', label: 'How many desks?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['office'] },
      options: [
        { value: '20', label: 'Up to 20', rateKey: 'office_small' },
        { value: '100', label: '21 to 100', rateKey: 'office_mid' },
        { value: '100plus', label: 'More than 100' },
      ] },
    { id: 'school_size', type: 'choice', label: 'What kind of school?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['school'] },
      options: [
        { value: 'small', label: 'Nursery or small primary school', rateKey: 'school_small' },
        { value: 'large', label: 'Large primary or secondary school', rateKey: 'school_large' },
        { value: 'intl', label: 'International school, boarding school or university', rateKey: 'school_intl' },
      ] },
    { id: 'beds', type: 'choice', label: 'How many beds?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['hospital'] },
      options: [
        { value: '50', label: 'Up to 50', rateKey: 'hospital_50' },
        { value: '50plus', label: 'More than 50', rateKey: 'hospital_large' },
      ] },
  ],
  pricing: {
    sector: 'business',
    base: { from: ['desks', 'school_size', 'beds', 'kind'] },
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

export const farms: IndustryModule = {
  key: 'farms',
  version: 1,
  label: 'Farms and factories',
  enabled: true,
  resultMode: 'instant',
  questions: [
    { id: 'kind', type: 'choice', label: 'What should we shoot?', required: true, drivesPrice: true,
      options: [
        { value: 'farm', label: 'Farm or greenhouse, up to 5 acres', rateKey: 'farm_5' },
        { value: 'farm_large', label: 'Farm larger than 5 acres' },
        { value: 'estate', label: 'Flower, tea or coffee estate with processing', rateKey: 'estate_processing' },
        { value: 'factory', label: 'Factory or processing plant', rateKey: 'factory' },
        { value: 'warehouse', label: 'Warehouse' },
        { value: 'hq', label: 'Company HQ, for recruitment or investors', rateKey: 'company_hq' },
        { value: 'training', label: 'Staff training or safety induction tour', rateKey: 'training_tour' },
      ] },
    { id: 'warehouse_size', type: 'choice', label: 'How big is the warehouse?', required: true, drivesPrice: true,
      showIf: { question: 'kind', in: ['warehouse'] },
      options: [
        { value: '10k', label: 'Up to 10,000 sq ft', rateKey: 'warehouse_10k' },
        { value: '50k', label: '10,000 to 50,000 sq ft', rateKey: 'warehouse_50k' },
        { value: '50kplus', label: 'More than 50,000 sq ft' },
      ] },
  ],
  pricing: {
    sector: 'business',
    base: { from: ['warehouse_size', 'kind'] },
    addons: businessAddons,
    premiumAddons: ['video', 'reel', 'photos_20'],
    hostingKey: 'hosting_business',
  },
}

export const modules: Record<string, IndustryModule> = { homes, airbnb, hotels, vehicles, restaurants, developers, malls, institutions, farms, other }

// Every rate key a module points at must exist in the table it prices
// against. Run on startup and in tests so a typo can't reach a visitor.
export function validateModule(module: IndustryModule, table: RateTable): string[] {
  const p = module.pricing
  const keys = [
    ...module.questions.flatMap(q => q.options?.map(o => o.rateKey).filter(Boolean) as string[] ?? []),
    ...(p.perScene ? [p.perScene.rateKey] : []),
    ...(p.perUnit ?? []).map(x => x.rateKey),
    ...(p.uplifts ?? []).map(x => x.rateKey),
    ...(p.discounts ?? []).flatMap(d => d.ladder.map(s => s.rateKey)),
    ...p.addons, ...p.premiumAddons, p.hostingKey, `min_${p.sector}`,
  ]
  const questionIds = new Set(module.questions.map(q => q.id))
  const refs = [
    ...(p.base?.from ?? []), ...(p.quantity ? [p.quantity.question] : []),
    ...(p.discounts ?? []).map(d => d.question), ...(p.perUnit ?? []).map(x => x.question),
  ]
  return [
    ...keys.filter(k => !table.items[k]).map(k => `${module.key}: unknown rate key "${k}"`),
    ...refs.filter(id => !questionIds.has(id)).map(id => `${module.key}: unknown question "${id}"`),
  ]
}
