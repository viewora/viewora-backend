// Rate table v1, seeded from docs/rate-card.md (Viewora Pricing & Rate Card
// 2026). This is the ONLY place prices are typed; once the admin rate editor
// ships, the published table in the database replaces this seed.
//
// Ranges keep both ends (low/high) and `use` says which one the engine
// charges. "From X" prices have high = null; `custom` means staff quote it.

import type { RateItem, RateTable } from '../engine/types.js'

type Opts = Partial<Omit<RateItem, 'key' | 'category' | 'label'>>

const item = (category: RateItem['category']) =>
  (key: string, label: string, low: number | null, high: number | null = low, opts: Opts = {}): RateItem =>
    ({ key, category, label, unit: 'job', low, high, use: 'low', ...opts })

const base = item('base')
const addon = item('addon')
const uplift = (key: string, label: string, bp: number) => item('uplift')(key, label, bp, bp, { unit: 'bp' })
const discount = (key: string, label: string, bp: number, highBp = bp) => item('discount')(key, label, bp, highBp, { unit: 'bp' })

const items: RateItem[] = [
  // ── Minimums and per-scene rates ─────────────────────────────────────────
  item('minimum')('min_home', 'Minimum job price (homes)', 4500),
  item('minimum')('min_business', 'Minimum job price (business)', 7000),
  base('scene_home', '360° scene', 450, 550, { unit: 'scene', industry: 'generic' }),
  base('scene_business', '360° scene', 800, 1000, { unit: 'scene', industry: 'generic' }),

  // ── Homes and short-stay ─────────────────────────────────────────────────
  base('home_studio', 'Studio / bedsitter tour', 4500, 4500, { industry: 'homes', scenes: 6 }),
  base('home_1br', '1 bedroom tour', 5500, 5500, { industry: 'homes', scenes: 10 }),
  base('home_2br', '2 bedroom tour', 7000, 7000, { industry: 'homes', scenes: 14 }),
  base('home_3br', '3 bedroom / townhouse tour', 9000, 9000, { industry: 'homes', scenes: 20 }),
  base('home_villa', '4-5 bedroom villa / maisonette tour', 13500, 13500, { industry: 'homes', scenes: 28 }),
  base('home_mansion', '6+ bedroom mansion tour', 20000, 20000, { industry: 'homes', scenes: 40 }),
  base('home_estate', 'Gated estate / multi-unit compound', 25000, null, { industry: 'homes', custom: true }),
  uplift('sale_uplift', 'For-sale listing (+30%)', 3000),
  addon('airbnb_pro_pack', 'Airbnb Pro Pack: 20 edited photos + vertical reel', 3500),

  // ── Agent packs and same-building ladders ────────────────────────────────
  discount('pack_5', '5-listing pack (10% off)', 1000),
  discount('pack_10', '10-listing pack (15% off)', 1500),
  discount('pack_20', '20+ listing pack (20% off)', 2000),
  discount('same_building_2_5', '2nd-5th unit in the same building (15% off)', 1500),
  discount('same_building_6', '6th+ unit in the same building (25% off)', 2500),
  base('condition_report_small', 'Rental condition report, studio-1BR', 4000, 4000, { industry: 'agents' }),
  base('condition_report_mid', 'Rental condition report, 2-3BR', 6000, 6000, { industry: 'agents' }),
  base('condition_report_large', 'Rental condition report, 4BR+', 9000, 9000, { industry: 'agents' }),

  // ── Developers, land and other property ──────────────────────────────────
  base('dev_show_unit', 'Show unit tour', 15000, 15000, { industry: 'developers' }),
  base('dev_show_unit_plus', 'Show unit + amenities + exterior', 35000, 35000, { industry: 'developers' }),
  base('dev_full', 'Full development tour', 60000, 150000, { industry: 'developers' }),
  base('dev_progress', 'Construction progress capture (per visit)', 8000, 20000, { industry: 'developers', unit: 'visit' }),
  base('dev_block', 'Whole apartment block (amenities + 1 show unit)', 25000, 25000, { industry: 'developers' }),
  base('hostel_20', 'Student hostel / co-living, up to 20 rooms', 15000, 15000, { industry: 'developers' }),
  base('hostel_60', 'Student hostel / co-living, 21-60 rooms', 25000, 25000, { industry: 'developers' }),
  base('hostel_60plus', 'Student hostel / co-living, 60+ rooms', 40000, 40000, { industry: 'developers' }),
  base('commercial_let', 'Commercial space to let (per unit)', 6000, 12000, { industry: 'developers', unit: 'unit' }),
  base('memorial_park', 'Memorial park / cemetery', 25000, null, { industry: 'developers', custom: true }),
  base('land_plot', 'Single plot (50 × 100 ft)', 3500, 3500, { industry: 'land' }),
  base('land_half_acre', 'Multiple plots, up to ½ acre', 5500, 5500, { industry: 'land' }),
  base('land_1_acre', '½-1 acre', 8000, 8000, { industry: 'land' }),
  base('land_5_acres', '1-5 acres', 12000, 12000, { industry: 'land' }),
  base('land_20_acres', '5-20 acres', 18000, 18000, { industry: 'land' }),
  base('land_50_acres', '20-50 acres', 28000, 28000, { industry: 'land' }),
  base('land_50plus', '50+ acres', null, null, { industry: 'land', custom: true }),

  // ── Hospitality and tourism ──────────────────────────────────────────────
  base('hotel_guesthouse', 'Guesthouse / B&B (up to 8 rooms)', 15000, 15000, { industry: 'hotels' }),
  base('hotel_10', 'Hotel, up to 10 rooms', 25000, 25000, { industry: 'hotels' }),
  base('hotel_25', 'Hotel, 11-25 rooms', 35000, 35000, { industry: 'hotels' }),
  base('hotel_50', 'Hotel, 26-50 rooms', 50000, 50000, { industry: 'hotels', scenes: 50 }),
  base('hotel_100', 'Hotel, 51-100 rooms', 70000, 70000, { industry: 'hotels', scenes: 90 }),
  base('hotel_200', 'Hotel, 101-200 rooms', 95000, 95000, { industry: 'hotels' }),
  base('hotel_200plus', 'Hotel, 200+ rooms', 120000, null, { industry: 'hotels', custom: true }),
  base('safari_15', 'Safari camp / resort, up to 15 tents or rooms', 60000, 60000, { industry: 'hotels' }),
  base('safari_40', 'Safari camp / resort, 16-40 tents or rooms', 85000, 85000, { industry: 'hotels' }),
  base('safari_40plus', 'Safari camp / resort, 40+', null, null, { industry: 'hotels', custom: true }),
  discount('lodge_group_5', 'Tour operator, 5+ lodges (15% off)', 1500),
  base('cafe', 'Café', 7000, 7000, { industry: 'restaurants' }),
  base('restaurant', 'Restaurant / bar', 10000, 10000, { industry: 'restaurants' }),
  base('restaurant_large', 'Multi-level, rooftop or large outdoor restaurant', 15000, 15000, { industry: 'restaurants' }),
  base('venue_100', 'Event venue, up to 100 guests', 12000, 12000, { industry: 'restaurants' }),
  base('venue_300', 'Event venue, 100-300 guests', 25000, 25000, { industry: 'restaurants' }),
  base('venue_300plus', 'Event venue, 300+ or multi-hall', 40000, 40000, { industry: 'restaurants' }),
  base('attraction', 'Attraction, conservancy, cultural centre, zoo, botanical garden', 25000, null, { industry: 'tourism', custom: true }),
  base('theme_park', 'Theme park, water park, beach club', 25000, 50000, { industry: 'tourism' }),
  base('golf_course', 'Golf course (18 holes)', 60000, null, { industry: 'tourism', custom: true }),
  base('golf_clubhouse', 'Golf clubhouse', 15000, 15000, { industry: 'tourism' }),
  base('nightlife', 'Nightclub, lounge, cinema, bowling', 10000, 20000, { industry: 'restaurants' }),
  base('stadium', 'Stadium / sports ground', null, null, { industry: 'tourism', custom: true }),

  // ── Malls, retail and offices ────────────────────────────────────────────
  base('mall_arcade', 'Arcade / neighbourhood centre (common areas)', 35000, 35000, { industry: 'malls' }),
  base('mall_community', 'Community mall (common areas)', 70000, 95000, { industry: 'malls' }),
  base('mall_regional', 'Regional mall (common areas)', 150000, 250000, { industry: 'malls', scenes: 200 }),
  base('mall_super', 'Super-regional mall (common areas)', 300000, null, { industry: 'malls', custom: true }),
  base('mall_tenant', 'Tenant shop shot during the mall visit', 4000, 4000, { industry: 'malls', unit: 'unit' }),
  base('mall_anchor', 'Anchor tenant (supermarket, cinema)', 20000, null, { industry: 'malls', custom: true }),
  base('shop', 'Shop / boutique', 7000, 7000, { industry: 'malls' }),
  base('supermarket', 'Supermarket / large store', 25000, 60000, { industry: 'malls' }),
  base('showroom_furniture', 'Furniture / appliance showroom', 12000, 25000, { industry: 'malls' }),
  base('fashion_flagship', 'Fashion flagship store', 10000, 10000, { industry: 'malls' }),
  base('popup', 'Pop-up / temporary space', 5000, null, { industry: 'malls' }),
  base('office_small', 'Small office (up to 20 desks)', 10000, 10000, { industry: 'institutions' }),
  base('office_mid', 'Mid office (up to 100 desks)', 20000, 20000, { industry: 'institutions' }),
  base('coworking', 'Co-working flagship', 25000, 40000, { industry: 'institutions' }),
  base('salon', 'Salon / barber', 6000, 6000, { industry: 'malls' }),
  base('gym_spa', 'Gym / spa', 10000, 18000, { industry: 'malls' }),
  uplift('night_uplift', 'Night or pre-opening shoot (+20%)', 2000),

  // ── Health, education and institutions ───────────────────────────────────
  base('pharmacy', 'Pharmacy', 7000, 7000, { industry: 'institutions' }),
  base('vet_clinic', 'Vet clinic', 10000, 10000, { industry: 'institutions' }),
  base('clinic', 'Clinic / dental', 10000, 15000, { industry: 'institutions' }),
  base('lab', 'Diagnostic lab', 15000, 15000, { industry: 'institutions' }),
  base('hospital_50', 'Private hospital (up to 50 beds)', 50000, 50000, { industry: 'institutions' }),
  base('hospital_large', 'Larger hospital', null, null, { industry: 'institutions', custom: true }),
  base('school_small', 'Nursery / small primary school', 18000, 18000, { industry: 'institutions' }),
  base('school_large', 'Large primary / secondary school', 35000, 35000, { industry: 'institutions' }),
  base('school_intl', 'International school, boarding school or university', 60000, null, { industry: 'institutions', custom: true }),
  base('museum', 'Museum / gallery / heritage site', 15000, null, { industry: 'institutions', custom: true }),
  discount('community_rate', 'Community rate: churches, NGOs, community groups (10% off)', 1000),
  base('government', 'Government / county project', null, null, { industry: 'institutions', custom: true }),

  // ── Farming, manufacturing and corporate ─────────────────────────────────
  base('farm_5', 'Farm / greenhouse, up to 5 acres', 15000, 15000, { industry: 'farms' }),
  base('estate_processing', 'Flower, tea or coffee estate with processing', 35000, 80000, { industry: 'farms' }),
  base('factory', 'Factory / processing plant', 40000, 120000, { industry: 'farms' }),
  base('warehouse_10k', 'Warehouse, up to 10,000 sq ft', 15000, 15000, { industry: 'farms' }),
  base('warehouse_50k', 'Warehouse, up to 50,000 sq ft', 30000, 30000, { industry: 'farms' }),
  base('company_hq', 'Company HQ (recruitment or investor tour)', 20000, 40000, { industry: 'farms' }),
  base('training_tour', 'Staff training or safety induction tour', 25000, 60000, { industry: 'farms' }),

  // ── Vehicles, equipment and portfolios ───────────────────────────────────
  base('showroom_10', 'Car showroom, up to 10 vehicles', 10000, 10000, { industry: 'vehicles' }),
  base('showroom_30', 'Car showroom, up to 30 vehicles', 18000, 18000, { industry: 'vehicles' }),
  base('vehicle_spin', 'Interior 360° spin, per vehicle', 1500, 1500, { industry: 'vehicles', unit: 'unit', tiers: [{ min: 10, amount: 1000 }] }),
  base('car_hire_vehicle', 'Car hire vehicle tour', 2500, 2500, { industry: 'vehicles', unit: 'unit', tiers: [{ min: 5, amount: 1800 }, { min: 20, amount: 1200 }] }),
  base('garage', 'Garage / car wash', 7000, 7000, { industry: 'vehicles' }),
  base('boat', 'Boat or yacht charter, per vessel', 6000, 6000, { industry: 'vehicles', unit: 'unit' }),
  base('machinery', 'Heavy machinery rental, per machine', 2500, 2500, { industry: 'vehicles', unit: 'unit' }),
  base('portfolio_project', 'Interior designer / architect portfolio project', 8000, 15000, { industry: 'portfolios' }),
  discount('portfolio_3', '3+ portfolio projects (15% off)', 1500),

  // ── Add-ons ──────────────────────────────────────────────────────────────
  addon('extra_scene_home', 'Extra scene', 500, 500, { unit: 'scene', meta: { addsScenes: true } }),
  addon('extra_scene_business', 'Extra scene', 900, 900, { unit: 'scene', meta: { addsScenes: true } }),
  addon('video', '360° video walkthrough', 8000, 15000),
  addon('reel', 'Social reel, 30-60 sec vertical', 8000, 12000),
  addon('photos_20', '20 edited photos', 4000),
  addon('hotspot_pack', 'Hotspot / info-tag pack', 2000),
  addon('branding', 'Branding and custom domain', 3000),
  addon('website_embed', 'Website embed', 2000),
  addon('google_maps', 'Google Maps publishing', 3500),
  addon('rush', 'Rush delivery, 24 hours', 3000, 3000, { unit: 'bp' }),
  addon('extra_revision', 'Extra revision round', 1500),
  addon('drone', 'Drone aerials', null, null, { custom: true, meta: { note: 'Subcontract at cost +20%; no published price until we own a drone' } }),
  discount('refresh_12m', 'Refresh shoot within 12 months (50% off)', 5000),
  addon('floorplan_home_redraw', 'Floor plan: clean up and redraw your plan', 1500),
  addon('floorplan_home_draw', 'Floor plan: drawn from the 360 scenes', 2000),
  addon('floorplan_home_measured', 'Floor plan: measured, with room sizes', 3500, 7000),
  addon('floorplan_biz_redraw', 'Floor plan: clean up and redraw (per floor)', 3000, 8000, { unit: 'floor' }),
  addon('floorplan_biz_draw', 'Floor plan: drawn from the 360 scenes (per floor)', 5000, 12000, { unit: 'floor' }),
  addon('floorplan_biz_measured', 'Floor plan: measured (per floor)', 8000, 25000, { unit: 'floor' }),
  addon('scoping_visit', 'Scoping visit (credited back if you book)', 5000),

  // ── Chains and special rates ─────────────────────────────────────────────
  discount('branch_2_5', '2nd-5th branch (20% off)', 2000),
  discount('branch_6_20', '6th-20th branch (30% off)', 3000),
  discount('branch_21', '21st+ branch (40% off, framework agreement)', 4000),
  discount('founding_client', 'Founding client rate', 2500, 3000),
  discount('care_hotel', 'Hotel care plan: quarterly refresh (30% off)', 3000),

  // ── Travel ───────────────────────────────────────────────────────────────
  item('travel')('travel_nairobi', 'Travel: Nairobi, within ~15 km', 0, 0, { meta: { maxKm: 15, towns: ['nairobi'] } }),
  item('travel')('travel_greater', 'Travel: Greater Nairobi', 2000, 2000, { meta: { maxKm: 40, towns: ['kiambu', 'kitengela', 'ngong', 'rongai', 'thika'] } }),
  item('travel')('travel_regional', 'Travel: 40-150 km', 5000, 5000, { meta: { maxKm: 150, towns: ['naivasha', 'nyeri', 'machakos'] } }),
  item('travel')('travel_far', 'Travel: 150 km+ (actual cost + accommodation + per diem)', null, null, { custom: true, meta: { towns: ['mombasa', 'kisumu', 'mara'] } }),
  item('travel')('travel_per_diem', 'Per diem, far jobs', 1500, 1500, { meta: { perDiem: true } }),
  item('travel')('travel_unconfirmed', 'Travel: our team confirms it', null, null, { custom: true, meta: { placeholder: true } }),

  // ── Hosting renewals (after the included 12 months) ──────────────────────
  item('hosting')('hosting_home', 'Yearly hosting renewal, homes', 3000),
  item('hosting')('hosting_business', 'Yearly hosting renewal, standard business', 6000),
  item('hosting')('hosting_large', 'Yearly hosting renewal, large business', 12000, null),

  // ── Software plan scene caps (per tour) ──────────────────────────────────
  item('plan_cap')('plan_free', 'Free', 5, 5, { unit: 'scenes', meta: { plan: 'free' } }),
  item('plan_cap')('plan_creator', 'Creator', 25, 25, { unit: 'scenes', meta: { plan: 'creator' } }),
  item('plan_cap')('plan_professional', 'Professional', 75, 75, { unit: 'scenes', meta: { plan: 'professional' } }),
  item('plan_cap')('plan_business', 'Business', 150, 150, { unit: 'scenes', meta: { plan: 'business' } }),
]

export const rateTableV1: RateTable = {
  id: 'seed-v1',
  version: 1,
  effectiveFrom: '2026-10-27',
  settings: {
    vat: { enabled: false, rateBp: 1600 },
    discountCapBp: 2000,
    depositBp: 5000,
    usdKesRate: 130,
    quoteValidityDays: 7,
    includedHostingMonths: 12,
    origin: { lat: -1.2864, lng: 36.8172 },  // Nairobi CBD
  },
  items: Object.fromEntries(items.map(i => [i.key, i])),
}
