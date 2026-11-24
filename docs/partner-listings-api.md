# Viewora Partner API: listings

Send your property and vehicle listings to Viewora and keep them in sync.
Your system owns the listing facts (price, availability, location, photos).
Viewora owns the tour, the public page and moderation. Sync is one way, from
you to Viewora. Viewora never writes back into your system.

Developers should read https://api.viewora.software/docs (guide, full reference and Try it). Base URL: `https://api.viewora.software/v1`. Keys, agents and tours work as in
[partner-api.md](partner-api.md). The full machine-readable description is at
`GET /v1/openapi.json`, also saved as `docs/partner-api.openapi.json`. A
Postman collection is in `docs/partner-api.postman.json`.

## Rules for every request

- **Money is a whole number:** KES in shillings, USD in cents. `85000.5` and `"85000"` are refused, never rounded.
- **Timestamps** are ISO 8601. **Unknown fields are refused** rather than ignored.
- **Send `Idempotency-Key: <uuid>` on every POST, PATCH and DELETE.**
  - Retrying with the same key and body returns the first answer, with the header `Idempotent-Replayed: true`, for 24 hours.
  - The same key with a different body is refused with `422 IDEMPOTENCY_KEY_REUSED`.
- **Every response has `X-Request-Id`.** Quote it when you contact support.
- **Ids.** A listing is `lst_<uuid>` (Viewora's id). You can always use `ext:<your id>` instead, for example `/v1/listings/ext:HSE-0042`.
- **Another partner's ids always answer 404.**

## Scopes

Each key carries scopes:

| Scope | Allows |
|---|---|
| `listings:read` | Reading your listings, imports, reconcile and export |
| `listings:write` | Creating, updating, archiving and restoring listings, and bulk imports |
| `media:write` | Adding photos |
| `agents:write` | Creating agents |
| `webhooks:manage` | Managing your webhooks |
| `analytics:read` | Views |
| `leads:read` | Contact details of people who asked about your listings |

New keys get every scope except `analytics:read` and `leads:read`. Viewora adds `analytics:read` on request, and `leads:read` only after the data-processing addendum is signed.

New keys expire after 12 months. A missing scope answers `403 SCOPE_MISSING`, and an expired key answers `401 KEY_EXPIRED`.

## 1. Create a listing

```bash
curl -X POST https://api.viewora.software/v1/listings \
  -H "Authorization: Bearer vo_test_…" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 0f9a6e2c-5a1d-4f6b-9a77-2f1d7c1b9e10" \
  -d '{
    "external_id": "HSE-0042",
    "agent_external_id": "agent-118",
    "vertical": "property",
    "transaction": "rent",
    "title": "2-bedroom apartment, Kilimani",
    "description": "Second floor, borehole water, lift.",
    "price": { "amount": 85000, "currency": "KES", "period": "month" },
    "deposit": { "amount": 170000, "currency": "KES" },
    "availability": "available",
    "location": { "county": "Nairobi", "area": "Kilimani", "estate": "Argwings Kodhek Rd" },
    "property": { "property_type": "apartment", "bedrooms": 2, "bathrooms": 2, "amenities": ["borehole", "lift"] },
    "media": [
      { "kind": "photo", "source_url": "https://cdn.example.co.ke/hse-0042/1.jpg" },
      { "kind": "photo", "source_url": "https://cdn.example.co.ke/hse-0042/2.jpg" },
      { "kind": "photo", "source_url": "https://cdn.example.co.ke/hse-0042/3.jpg" }
    ],
    "publish": true
  }'
```

`agent_external_id` is required: create the agent first with `POST /v1/agents`. A tour you already made with `POST /v1/tours` under the same `external_id` becomes this listing.

The answer is `201` with the listing, including `id`, `version`, `tour_id` and `publication_status`. Photos sent by `source_url` are fetched in the background, and the listing goes live when they are ready.

Fetching photos by URL:
- **Allowed:** `https://` URLs on public addresses only. Redirects are not followed.
- **Formats:** JPEG, PNG or WebP.
- **Size:** up to 25 MB for a photo, 60 MB for a 360° panorama.

To upload files from your server instead, use `POST /v1/tours/{tour_id}/uploads` (see partner-api.md).

Vehicles use a `vehicle` block instead of `property`:

```json
"vehicle": { "make": "Toyota", "model": "Land Cruiser Prado", "variant": "TX", "year": 2019,
  "mileage_km": 68000, "transmission": "automatic", "fuel_type": "diesel", "vin": "JTEBH3FJ10K123456" }
```

Vehicles are for sale only in v1. Viewora stores the VIN and chassis number only as fingerprints for spotting duplicates, and shows them masked (`vin_masked`). Car photos use `"kind": "car_exterior"` with an `angle` (0 = front).

## 2. Publication status

Availability is yours: `available`, `reserved`, `sold`, `rented` or `withdrawn`. Publication is Viewora's:

| `publication_status` | Meaning |
|---|---|
| `draft` | Saved with `publish: false`, or `withdrawn` |
| `submitted` | Waiting for photos to be fetched |
| `pending_moderation` | A person at Viewora is checking it, usually within 4 working hours |
| `published` | Live on Viewora and in embeds |
| `rejected` | Something is missing or a moderator refused it; see `moderation.reasons` |
| `expired` | No update for 60 days (rentals) or 90 days (sales and vehicles) |
| `archived` | Deleted; restorable for 30 days |

To publish, a listing needs:

| | Property | Vehicle |
|---|---|---|
| Price | Price, or `price_on_request` | Price |
| Location | County and area | County and area |
| Details | Bedrooms (not needed for land or commercial types) | Mileage, transmission and fuel type |
| Media | 3 photos, or one 360° photo | 4 photos |

**What goes to review on live keys.** Test keys are never held for review. On live keys these are checked by a person:
- your first 50 listings,
- phone numbers, emails or links in the title or description,
- a VIN already listed on Viewora,
- a listing changed after a moderator rejected it,
- on a live listing, a price drop of more than 30%, a currency change, or a third price change in 24 hours.

A held price change answers `202` with `held_for_review: true`. The public page keeps the old price until the review. Until then, any PATCH to that listing answers `423 LISTING_LOCKED`.

**Expiry.** To keep a listing from expiring, send it again. An unchanged PATCH or bulk item is enough: it answers `changed: false` and pushes the expiry out without creating a new version.

## 3. Update

```bash
curl -X PATCH https://api.viewora.software/v1/listings/ext:HSE-0042 \
  -H "Authorization: Bearer vo_live_…" -H "Content-Type: application/json" \
  -H "If-Match: 3" -H "Idempotency-Key: …" \
  -d '{ "availability": "rented", "partner_updated_at": "2026-12-01T09:00:00Z" }'
```

- **Send only what changed.** A block you send (`price`, `location`, `property`, `vehicle`, `media`) replaces the stored block. Sending `media` replaces the photo list, and photos you leave out are removed from the tour.
- **`If-Match: <version>`.** If someone else changed the listing first, you get `409 VERSION_CONFLICT`.
- **`partner_updated_at`** is your own clock. An update older than the stored one is ignored and answers `applied: false, reason: "stale"`, which protects you from retries arriving out of order.
- **Fields you can't change:**
  - Viewora's own fields (`publication_status`, `version`, `urls` and so on) answer `409 FIELD_OWNED_BY_OTHER`.
  - `external_id` and `vertical` answer `409 FIELD_IMMUTABLE`.
- **Changing the agent:** send `agent_external_id` with another of your agents. The tour moves to that agent's Viewora account, with its views and enquiries. An unknown agent answers `404 AGENT_NOT_FOUND`.

## 4. Delete and restore

- **`DELETE /v1/listings/{id}`** archives the listing. It leaves the page at once and can be restored for 30 days with `POST /v1/listings/{id}/restore`. After 30 days the listing and its tour are deleted for good, the restore answers `404`, and the `external_id` can be used again.
- **The mass-delete guard.** Removing more than 10% of your active listings within an hour answers `409 BULK_DELETE_HELD`, because a broken export looks exactly like a mass delete. If you really mean it, send the request again with `{ "confirm_bulk_delete": true }`.

## 5. Read and keep in sync

- **`GET /v1/listings`** pages through your listings with a cursor. The default page is 50 and the maximum is 100.
  - Follow `next_cursor` until it is `null`.
  - Filters: `external_id`, `agent_external_id`, `availability`, `publication_status` and `updated_since`.
  - `sort` is one of `-updated_at`, `updated_at`, `-created_at` or `created_at`.
- **`POST /v1/listings/reconcile`** with `{ "items": [{ "external_id": "HSE-0042", "version": 3 }, …] }` checks your whole feed against Viewora's. It changes nothing and reports three things:
  - listings Viewora has that you didn't send (`not_in_your_list`),
  - ids Viewora doesn't know (`unknown_to_viewora`),
  - versions you are behind on (`version_behind`).

  Run it daily.

## 6. Bulk import (up to 500 listings per request)

```bash
curl -X POST https://api.viewora.software/v1/listings/bulk -H "Idempotency-Key: …" … \
  -d '{ "items": [ { …full listing… }, { "external_id": "HSE-0043", "availability": "rented" } ] }'
# → 202 { "import_id": "imp_…", "status": "queued", "status_url": "/v1/imports/imp_…" }
```

- **Each item:** an item whose `external_id` exists is a partial update; any other item is created.
- **Dry run:** add `"dry_run": true` to check every item without writing anything.
- **Concurrency:** one import runs at a time per partner, with up to three more waiting.
- **Results:** `GET /v1/imports/{id}` shows the counts (`created`, `updated`, `unchanged`, `failed`) and an error per failed row, with its `index`, `external_id`, `field` and `message`.

## 7. Add one photo

`POST /v1/media` with `{ "listing_id": "ext:HSE-0042", "kind": "photo", "source_url": "https://…" }` adds a photo to the listing's media list and fetches it in the background.

## 8. Claim a tour an agent made in Viewora

Some of your agents already have tours they made in the Viewora app (they
appear in the export feed with `origin: "viewora"`). To manage one as your
listing, ask the agent:

```bash
curl -X POST https://api.viewora.software/v1/claims … \
  -d '{ "tour_id": "6f1c…", "agent_external_id": "agent-118", "external_id": "HSE-0042", "note": "Listed with us since March" }'
# → 201 { "claim": { "id": "clm_…", "status": "pending", "expires_at": "…" } }
```

- **The agent decides.** The agent sees the request in the Viewora app and approves or declines it. You get `claim.approved` or `claim.declined`, and unanswered claims expire after 14 days (`claim.expired`).
- **After approval,** `POST /v1/listings` with the same `external_id` puts your listing on that tour instead of making a new one. From then on you own its facts (price, availability, photos).
- **Which tours:** only your own agent's tours can be claimed. Anything else answers `404 TOUR_NOT_FOUND`.
- **Other calls:** `GET /v1/claims` (filter by `status`), `GET /v1/claims/{id}`, and `DELETE /v1/claims/{id}` to withdraw a claim that is still waiting.

## 9. Webhooks

```bash
curl -X POST https://api.viewora.software/v1/webhooks … \
  -d '{ "url": "https://crm.example.co.ke/viewora", "events": ["listing.published", "listing.rejected", "import.completed"] }'
# → 201 { "webhook": { "id": "wh_…" }, "secret": "whsec_…" }   (the secret is shown once)
```

**Events:**
- `listing.created`, `listing.updated`, `listing.published`, `listing.unpublished`
- `listing.moderation_held`, `listing.rejected`, `listing.expired`
- `listing.archived`, `listing.restored`
- `media.failed`, `import.completed`
- `"*"` subscribes to all of them.

Each delivery is a POST with this body:

```json
{ "id": "evt_…", "type": "listing.published", "created_at": "…", "mode": "live",
  "data": { "listing": { "id": "lst_…", "external_id": "HSE-0042", "version": 4, "publication_status": "published", "availability": "available" } } }
```

**Checking the signature.** The header is `Viewora-Signature: t=<unix seconds>,v1=<hex>`. Compute HMAC-SHA256 of `t + "." + raw body` with your secret, compare it with `v1`, and refuse anything older than 5 minutes. In Node:

```js
const [t, v1] = header.split(',').map(p => p.split('=')[1])
const ok = Math.abs(Date.now() / 1000 - t) < 300 &&
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')))
```

**Answer with any 2xx within 10 seconds.**
- **Retries:** a failed delivery is retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h. That is 8 attempts in all.
- **Duplicates and order:** an event may arrive more than once or out of order. Use `id` to drop repeats and `version` to drop stale events.
- **Switched off:** an endpoint that fails for 3 days without one success is switched off. Fix it, then call `POST /v1/webhooks/{id}/enable`.

**Endpoint rules.** Endpoints must use `https://` on a public address, and you can have up to 5 per mode.

**Rotating the secret.** `POST /v1/webhooks/{id}/rotate-secret` returns a new secret (shown once). For 24 hours each delivery carries two signatures, one per secret: `t=…,v1=<new>,v1=<old>`. Accept the request if any `v1` matches, switch to the new secret, and the old one stops after 24 hours.

**When an endpoint is switched off,** Viewora emails your technical contact.

**Managing endpoints:**
- `GET /v1/webhooks` lists them.
- `GET /v1/webhooks/{id}/deliveries` shows the last 50 deliveries.
- `POST /v1/webhooks/{id}/test` sends a test event.
- `DELETE /v1/webhooks/{id}` removes one.

Events never contain lead contact details.

## 10. Leads, analytics and export

- **`GET /v1/leads`** (`leads:read`) lists people who asked about your listings through Viewora pages.
  - Only buyers who ticked the box agreeing to share their details with you are listed. Each lead carries `consent.wording` (the exact words they agreed to) and `consent.given_at`.
  - A buyer can withdraw; their lead then disappears from this feed. Delete any copy you hold within the time your agreement sets.
  - Use leads only for the purpose stated in your agreement.
  - Every read is logged.
  - Filters: `listing_id` and `since`. Pages use a cursor.
- **`GET /v1/analytics?from=2026-11-01&to=2026-11-30`** (`analytics:read`) returns views per listing per day, for at most 92 days per request.
- **`GET /v1/export/listings`** (`listings:read`) is a read-only feed of your agents' published tours, including tours they made themselves in the Viewora app (`origin: "viewora"`). Show them on your site; don't edit them and send them back.

## Errors

The error shape is the same as the rest of `/v1`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": [{ "field": "price.amount", "message": "…" }] } }
```

Listing codes:

| Group | Codes |
|---|---|
| Input | `VALIDATION_ERROR`, `INVALID_FILTER`, `INVALID_CURSOR`, `INVALID_IF_MATCH`, `INVALID_IDEMPOTENCY_KEY` |
| Not found | `LISTING_NOT_FOUND`, `AGENT_NOT_FOUND`, `IMPORT_NOT_FOUND`, `WEBHOOK_NOT_FOUND` |
| Conflicts | `LISTING_EXISTS`, `VERSION_CONFLICT`, `FIELD_OWNED_BY_OTHER`, `FIELD_IMMUTABLE`, `LISTING_ARCHIVED`, `LISTING_NOT_ARCHIVED`, `AGENT_CHANGE_FAILED`, `BULK_DELETE_HELD`, `CLAIM_EXISTS`, `CLAIM_NOT_PENDING`, `TOUR_ALREADY_LINKED`, `IDEMPOTENCY_IN_PROGRESS`, `WEBHOOK_LIMIT` |
| Other | `IDEMPOTENCY_KEY_REUSED` (422), `LISTING_LOCKED` (423), `RESTORE_WINDOW_PASSED` (410), `LISTING_LIMIT_REACHED` (403), `TOO_MANY_ITEMS` (413), `IMPORT_CONCURRENCY` (429), `URL_NOT_HTTPS`, `URL_PRIVATE_NETWORK`, `RANGE_TOO_LARGE`, `SCOPE_MISSING`, `KEY_EXPIRED` |

## Limits

| What | Limit |
|---|---|
| Reads | 300 per minute per key |
| Listing changes | 120 per minute per key |
| Bulk requests | 10 per minute, 500 items each |
| Live listings | 2,000 per partner unless your agreement says otherwise |
| Media fetched | Counts toward your daily upload limit; past it, fetching continues after midnight EAT |
