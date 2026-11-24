# Introduction

Put 360° tours on your property and car listings. You create a Viewora account for each of your agents or dealers, send their listings, and show the tour on your own listing page.

- **Base URL:** `https://api.viewora.software/v1`
- **Format:** JSON in, JSON out. Timestamps are ISO 8601 in UTC.
- **Money is always a whole number:** KES in shillings, USD in cents. `85000.5` and `"85000"` are refused, never rounded.
- **Files for your tools:** this reference is also available as [OpenAPI](/docs/openapi.json) and as a [Postman collection](/docs/postman.json).

Every answer carries an `X-Request-Id` header. Quote it when you contact Viewora about a request.

# Quick start

Use your test key (`vo_test_…`) for all of this. Test agents, tours and listings are kept apart from live ones and are never shown to the public.

**1. Create an agent.** Each agent or dealer gets their own Viewora account.

```bash
curl -X POST https://api.viewora.software/v1/agents \
  -H "Authorization: Bearer $VIEWORA_KEY" -H "Content-Type: application/json" \
  -d '{"external_id":"agent-118","name":"Test Agent"}'
```

<!-- listings -->
**2. Send a listing.** Photos sent by URL are fetched in the background, and the listing goes live when they are ready.

```bash
curl -X POST https://api.viewora.software/v1/listings \
  -H "Authorization: Bearer $VIEWORA_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "external_id": "HSE-0042",
    "agent_external_id": "agent-118",
    "vertical": "property",
    "transaction": "rent",
    "title": "2-bedroom apartment, Kilimani",
    "price": { "amount": 85000, "currency": "KES", "period": "month" },
    "availability": "available",
    "location": { "county": "Nairobi", "area": "Kilimani" },
    "property": { "property_type": "apartment", "bedrooms": 2, "bathrooms": 2 },
    "media": [{ "kind": "photo", "source_url": "https://cdn.example.co.ke/hse-0042/1.jpg" }],
    "publish": true
  }'
```

**3. Hear about changes.** Register a webhook so you know when a listing goes live or is held for review. Keep the `secret` it returns: it is shown once.

```bash
curl -X POST https://api.viewora.software/v1/webhooks \
  -H "Authorization: Bearer $VIEWORA_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://crm.example.co.ke/viewora","events":["*"]}'
```

**4. Show the tour.** When the listing is published it has `urls.embed`. Put it in an iframe on your listing page:
<!-- /listings -->
<!-- tours-only -->
**2. Create a tour, upload photos and publish.** See **Tours** and **Uploads** in the reference. A published tour has `embed_url`. Put it in an iframe on your listing page:
<!-- /tours-only -->

```html
<iframe src="EMBED_URL" width="100%" height="480" style="border:0"
        allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy"></iframe>
<script src="https://app.viewora.software/embed.js" defer></script>
```

`embed.js` is optional; it lets the tour go full screen on iPhone. Tell Viewora which sites will show your tours (for example `https://cars.example.co.ke`, plus `http://localhost:3000` while you build). Tours then only load inside those sites.

When this works with your test key, ask Viewora for a live key and repeat with real data.

# Keys and scopes

Send your key on every request:

```
Authorization: Bearer vo_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

- `vo_test_…` is for building. `vo_live_…` is for real listings.
- Keep keys on your server. Never put them in a browser, a mobile app or a public repository.
- New keys expire after 12 months (`401 KEY_EXPIRED`). Ask Viewora for a new key before then.
- If a key leaks, tell Viewora at once. It is revoked and you get a new one.

Each key carries scopes. A missing scope answers `403 SCOPE_MISSING`.

| Scope | Allows |
|---|---|
| `agents:write` | Creating and reading agents |
| `listings:read` | Reading tours, listings, imports, claims and the export feed |
| `listings:write` | Creating and changing tours and listings, bulk imports and claims |
| `media:write` | Uploading and adding photos |
| `webhooks:manage` | Managing your webhooks |
| `analytics:read` | Views per listing (on request) |
| `leads:read` | Buyers who asked about your listings (after the data-processing addendum is signed) |

# Rules for every request

- **Unknown fields are refused** rather than ignored, so typos show up at once.
- **Send `Idempotency-Key: <uuid>` on every POST, PATCH and DELETE.** Retrying with the same key and body returns the first answer (with `Idempotent-Replayed: true`) for 24 hours. The same key with a different body answers `422 IDEMPOTENCY_KEY_REUSED`.
- **Your own ids work everywhere.** `external_id` is your id for an agent, tour or listing.<!-- listings --> A listing can be read as `/v1/listings/lst_…` (Viewora's id) or `/v1/listings/ext:HSE-0042` (yours).<!-- /listings -->
- **Another partner's ids always answer 404.**
- **Agents own their tours.** Each agent can sign in at app.viewora.software (with "Forgot password") and see the tours you made for them. Creating an agent sends no email.

<!-- listings -->
# Receiving events

Viewora POSTs an event to your endpoint when something changes. Endpoints must use `https://` on a public address, and you can have up to 5 per mode.

**Events:** `listing.created`, `listing.updated`, `listing.published`, `listing.unpublished`, `listing.moderation_held`, `listing.rejected`, `listing.expired`, `listing.archived`, `listing.restored`, `media.failed`, `import.completed`, `claim.approved`, `claim.declined`, `claim.expired`. Send `"*"` for all of them.

```json
{ "id": "evt_…", "type": "listing.published", "created_at": "2026-11-24T09:30:00Z", "mode": "live",
  "data": { "listing": { "id": "lst_…", "external_id": "HSE-0042", "version": 4, "publication_status": "published" } } }
```

## Check the signature

Every delivery has a `Viewora-Signature` header: `t=<unix seconds>,v1=<hex>`. Work out HMAC-SHA256 of `t + "." + raw body` with your secret, and accept the request if it matches any `v1` and `t` is less than 5 minutes old. Use the raw body exactly as received, before any JSON parsing.

**Node.js**

```js
import crypto from 'node:crypto'

export function verifyViewora(secret, rawBody, header) {
  const parts = header.split(',').map(p => p.split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)))
}
```

**PHP**

```php
function verify_viewora(string $secret, string $rawBody, string $header): bool {
    $t = 0; $sigs = [];
    foreach (explode(',', $header) as $part) {
        [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
        if ($k === 't') $t = (int) $v;
        if ($k === 'v1') $sigs[] = $v;
    }
    if ($t === 0 || abs(time() - $t) > 300) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    foreach ($sigs as $s) if (hash_equals($expected, $s)) return true;
    return false;
}
// $ok = verify_viewora($secret, file_get_contents('php://input'), $_SERVER['HTTP_VIEWORA_SIGNATURE'] ?? '');
```

**Python**

```python
import hashlib, hmac, time

def verify_viewora(secret: str, raw_body: bytes, header: str) -> bool:
    parts = [p.split("=", 1) for p in header.split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), "")
    sigs = [v for k, v in parts if k == "v1"]
    if not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)
```

## Delivery

- **Answer with any 2xx within 10 seconds.** Do slow work after you answer.
- **Retries:** a failed delivery is retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h.
- **Repeats and order:** an event can arrive more than once or out of order. Use `id` to drop repeats and the listing `version` to drop stale events.
- **Switched off:** an endpoint that fails for 3 days without one success is switched off, and Viewora emails your technical contact. Fix it, then call `POST /v1/webhooks/{id}/enable`.
- **New secret:** `POST /v1/webhooks/{id}/rotate-secret`. For 24 hours each delivery is signed with both secrets (`t=…,v1=<new>,v1=<old>`), so you can switch without missing events.
- Events never contain buyers' contact details.

# Claiming an agent's tour

An agent may already have a tour they made in the Viewora app. Ask to manage it with `POST /v1/claims` instead of making a second tour. The agent approves or declines in the app, and you get `claim.approved` or `claim.declined`. Claims nobody answers expire after 14 days (`claim.expired`). After approval, `POST /v1/listings` with the same `external_id` puts your listing on that tour.

# Leads and consent

`GET /v1/leads` lists buyers who asked about your listings through Viewora pages. It needs the `leads:read` scope, which Viewora grants only after the data-processing addendum is signed.

- Only buyers who ticked the box agreeing to share their details with you are listed. Each lead carries `consent.wording` (the exact words they agreed to) and `consent.given_at`.
- A buyer can withdraw. Their lead then leaves this feed, and you must delete any copy you hold within the time your agreement sets.
- Use leads only for the purpose in your agreement. Every read is logged.
<!-- /listings -->

# Errors

Every error has the same shape. Validation errors add `fields`.

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "price.amount must be a whole number",
             "fields": [{ "field": "price.amount", "message": "Expected an integer" }] } }
```

| Status | Meaning | What to do |
|---|---|---|
| 400 | The request is wrong (`VALIDATION_ERROR`) | Fix the fields listed, then retry |
| 401 | Missing, wrong, revoked or expired key | Check the key; ask Viewora for a new one |
| 403 | Scope missing, account suspended or a limit reached | Read `code`; contact Viewora if needed |
| 404 | Not found, or it belongs to another partner | Check the id and the key's mode (test or live) |
| 409 | Conflict, for example the `external_id` already exists | Read the existing item and update it instead |
| 422 | Idempotency key reused with a different body | Use a new key for a new request |
| 429 | Too many requests | Wait for `Retry-After` seconds, then retry |
| 5xx | A fault on Viewora's side | Retry with backoff and the same `Idempotency-Key` |

Each endpoint in the reference lists the codes it can return.

# Limits

| What | Limit |
|---|---|
| Reads | 300 per minute per key |
| Tour and listing changes | 120 per minute per key |
| Uploads | 600 per minute per key; 2,000 a day per partner unless agreed otherwise (resets at midnight EAT) |
| New agents | 60 per minute per key |
<!-- listings -->| Bulk imports | 10 requests per minute, 500 listings each |
| Live listings | 2,000 per partner unless agreed otherwise |
<!-- /listings -->
Plan limits (tours per agent, scenes per tour, file size) come from the plan your agreement pays for.
