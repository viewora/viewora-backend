# Partner listings: the data model (Phase 0)

Phase 0 of the partner integration platform. It defines what a partner
listing is, who owns each field, and what a listing needs before it can go
live. **No route uses it yet**: Phase 1 adds `/v1/listings` on top of it.

Strategy: "Viewora Partner Integration Platform — Strategy v1" (Claude Doc,
shared by the founders). Code: `src/partners/listingModel.ts`.
Migration: `src/utils/migration-partner-api-003.sql` (rollback `.down.sql`).

## One listing = one tour + partner-owned facts

A partner listing is **one tour** (a `properties` row), linked to the partner
through `api_partner_tours` under the partner's own `external_id`, exactly as
`/v1/tours` already works. Migration 003 adds what the tour row cannot hold:

| Table | Holds | Notes |
| --- | --- | --- |
| `api_listing_state` | One row per partner tour: availability (incl. reserved, withdrawn), publication status, price in KES or USD, deposit, service charge, coordinates, branch, the property/vehicle block, version, partner clock | `partner_id` and `mode` are copied from the tour ref by a trigger, so they cannot disagree |
| `api_audit_log` | Every change: who, what, before/after | Append-only: updates, deletes and TRUNCATE are refused; rows older than 24 months may be deleted |
| `api_idempotency_keys` | First response to a POST/PATCH/DELETE with an `Idempotency-Key` | Expires after 24 hours |

No existing table is changed. All three tables have RLS on and no policies, so
only the backend's service role can read them.

The tour row keeps showing the listing on existing pages (`toSpaceFacts`):

| Listing | Tour row | Why |
| --- | --- | --- |
| price in KES | `price_kes` | |
| price in USD | `price_kes` empty | The tour only knows KES; the real price stays in `api_listing_state` |
| `reserved` | `listing_status = available` | The tour has no reserved; the page adds the label from the state row (Phase 1) |
| `withdrawn` | `listing_status` empty | The tour is unpublished instead |
| `lease` | `transaction_type = rent` | |
| property type | `space_type` residential / commercial / land | vehicle → automotive |
| VIN, make, model, variant | car identity route (`carTour.ts`) | The state row keeps only SHA-256 hashes of VIN and chassis number |

## Who owns what

| Owner | Fields | A PATCH that sends it |
| --- | --- | --- |
| Partner | external_id, agent_external_id, branch, vertical, transaction, title, description, price, price_on_request, deposit, service_charge, availability, available_from, location, property, vehicle, media, partner_updated_at, publish | Accepted |
| Partner, fixed after create | external_id, vertical | `409 FIELD_IMMUTABLE` |
| Viewora | id, version, slug, publication_status, moderation, badges, urls, tours, published_at, expires_at, archived_at, restore_until, created_at, updated_at | `409 FIELD_OWNED_BY_OTHER` |
| Listing made in the Viewora app | everything | `409 LISTING_OWNED_BY_VIEWORA` until the agent approves a claim |

## Rules the model enforces

- **Money is an integer**: whole KES, or USD cents. `85000.5` and `"85000"` are refused, never rounded. (Postgres would round a decimal into a BIGINT silently, so the API check is the guard.)
- **Price period matches the transaction**: sale → `once`; rent → day/week/month/year; lease → month/year.
- Deposit and service charge need a price and use **the same currency**.
- **Vehicles are for sale only** in v1. A vehicle needs a `vehicle` block; a property needs a `property` block; never both.
- **County** must be one of Kenya's 47 counties; spelling is normalised (`nairobi city` → Nairobi, `muranga` → Murang'a).
- **Location** defaults to an approximate pin (`approx_500m`); `lat` and `lng` come together.
- **Descriptions** are stored as plain text (HTML tags removed).
- **Media URLs** must be `https://`; a `car_exterior` photo needs an `angle` (0 = front).
- **VIN**: 17 characters, no I, O or Q (check digit not enforced, for Japanese imports). Chassis numbers like `GDJ150-0012345` are accepted.
- **Unknown fields are refused**, not silently dropped.
- **Stale updates**: an update whose `partner_updated_at` is older than the stored one is ignored (a late retry). The same time is a safe retry.
- **Versions**: every accepted change adds 1. PATCH may send `If-Match: 3`, `"3"` or `W/"3"`.
- **Risky price changes** (held for review in Phase 1): a drop of more than 30%, a currency change, or 3+ changes in 24 hours. Rises are not held.

## Before a listing can be published

`publishBlockers()` returns the reasons; an empty list means it can go live.

| | Property | Vehicle |
| --- | --- | --- |
| Price | price, or `price_on_request` | price required |
| Location | county and area | county and area |
| Other | bedrooms (except land, office, shop, warehouse) | mileage, transmission, fuel type |
| Media | 3 photos, or 1 360° photo or tour | 4 photos (ordinary or exterior) |

These minimums are starting values, set in `PUBLISH_MEDIA_MINIMUM`. Tune them
once real listings arrive.

## Checking a design partner's real listings

Phase 0's exit test is mapping at least 150 real listings. Ask each design
partner for an export, then:

```bash
npm run partner:check-sample -- path/to/export.csv
npm run partner:check-sample -- path/to/export.json --json   # machine-readable
```

It prints how many listings are valid and ready to publish, repeated
`external_id`s, the most common problems, and each problem row. Nothing is
uploaded. Treat partner exports as personal data: keep them out of the repo
and delete them when done.

CSV headers use dotted names; start from `docs/partner-sample-template.csv`.
Amenities go in one cell separated by `|`. Numbers may contain thousands
separators (`85,000`). Booleans accept yes/no, true/false, 1/0.

## Testing the migration

`src/tests/partnerListingModel.test.ts` checks that every column the code
writes exists in migration 003, that 003 only adds `api_` tables with RLS, and
that the rollback drops them. `scripts/test-partner-migrations.mjs` applies
001–003 to a real Postgres (PGlite, in WebAssembly), exercises every
constraint and trigger, rolls back and re-applies. See the script header for
how to run it.
