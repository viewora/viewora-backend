// Shared by routes/public.ts (GET /listings) and routes/saved.ts (GET /saved)
// — both render the same card shape on the frontend (ListingCard.vue), so
// the row → listing mapping (hero image resolution, has_360 derivation)
// needs to stay identical rather than drift across two copies.

export const LISTING_SELECT_FRAGMENT = `
  id, slug, title, property_type, location_text, price_kes, listing_status,
  transaction_type, price_period,
  bedrooms, bathrooms, area_sqm, vehicle_year, vehicle_mileage_km,
  vehicle_transmission, vehicle_fuel_type, amenities, phone, cover_image_url, created_at,
  scenes ( thumbnail_url, order_index ),
  property_media ( public_url, media_type, sort_order, is_primary, processing_status, created_at )
`

export function mapListingRow(row: any) {
  // Prefer a real 360° scene thumbnail; fall back to a processed gallery
  // photo — the first real display surface gallery-only listings get
  // anywhere in the product. Falls back to cover_image_url, then null.
  const sceneThumb = (row.scenes || [])
    .filter((s: any) => s.thumbnail_url)
    .sort((a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0))[0]?.thumbnail_url

  const galleryPhoto = (row.property_media || [])
    .filter((m: any) => m.media_type === 'gallery_image' && m.processing_status === 'complete' && m.public_url)
    .sort((a: any, b: any) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]?.public_url

  // A car that is only exterior photos has no scene or gallery photo: use its
  // first-uploaded exterior photo (the Front slot in a normal shoot).
  const carPhoto = (row.property_media || [])
    .filter((m: any) => m.media_type === 'vehicle_view' && m.processing_status === 'complete' && m.public_url)
    .sort((a: any, b: any) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0]?.public_url

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    space_type: row.property_type,
    location_text: row.location_text,
    price_kes: row.price_kes,
    listing_status: row.listing_status,
    transaction_type: row.transaction_type,
    price_period: row.price_period,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    area_sqm: row.area_sqm,
    vehicle_year: row.vehicle_year,
    vehicle_mileage_km: row.vehicle_mileage_km,
    vehicle_transmission: row.vehicle_transmission,
    vehicle_fuel_type: row.vehicle_fuel_type,
    amenities: row.amenities || [],
    phone: row.phone,
    // Distinguishes a real 360° scene thumbnail from a flat gallery/cover
    // photo — the frontend must not badge the latter as "360°".
    has_360: Boolean(sceneThumb),
    hero_image: sceneThumb || galleryPhoto || carPhoto || row.cover_image_url || null,
    created_at: row.created_at,
  }
}
