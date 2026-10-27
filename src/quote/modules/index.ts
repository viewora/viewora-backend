// Industry modules. Each is plain config: its questions, which answers
// drive the price (by pointing at rate table keys) and its result mode.
// Add an industry by adding a module here — the engine needs no changes.
// Question text is the English default; the form's strings file can
// override it per locale using `quote.modules.<module>.<question>`.

import type { ChoiceOption, IndustryModule, RateTable } from '../engine/types.js'

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
      min: 1, max: 200, default: 1, drivesPrice: true, clientTypes: ['agent', 'manager', 'developer'] },
    { id: 'same_building', type: 'number', label: 'How many of them are in the same building?', min: 1, max: 200, default: 1,
      drivesPrice: true, clientTypes: ['agent', 'manager', 'developer'] },
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

export const modules: Record<string, IndustryModule> = { homes, airbnb, hotels, vehicles, other }

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
