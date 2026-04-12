# PROJECT_CONTEXT.md — viewora-backend

Single source of truth for AI assistants and developers working in this repo. Updated April 2026.

---

## What This Repo Is

The Fastify REST API that powers the entire Viewora platform. All business logic, quota enforcement, subscription management, and media storage orchestration live here.

- **GitHub repo**: `viewora-backend` (standalone, separate from app and marketing)
- **Deployed to**: Railway → `api.viewora.software`
- **Framework**: Fastify 5, TypeScript, Node.js ≥ 22
- **Build**: `tsc` → `dist/`, entry point `node dist/index.js`

---

## The Full Viewora System (for context)

Viewora is three independent repos. This repo is one of them.

| Repo | URL | Platform | Purpose |
|---|---|---|---|
| `viewora-app` | `app.viewora.software` | Vercel | Auth dashboard + public space viewer |
| **viewora-backend** (this repo) | `api.viewora.software` | Railway | Fastify REST API — all business logic |
| `viewora-marketing` | `viewora.software` | Vercel | Public marketing + SEO site (Nuxt SSG) |

**Infrastructure this backend directly manages:**
- **Supabase** — Postgres database + auth verification (service-role key, bypasses RLS)
- **Cloudflare R2** — media storage (presigned URL generation via AWS SDK v3)
- **Paystack** — payment processing (transaction init + webhook handling)

---

## Request Authentication

Every protected route uses `{ preHandler: [fastify.authenticate] }` or `fastify.addHook('preHandler', fastify.authenticate)`.

`fastify.authenticate` (defined in `src/plugins/auth.ts`):
1. Reads `Authorization: Bearer <token>` header.
2. Calls `fastify.supabase.auth.getUser(token)` — **not local JWT parsing**. This handles key rotation and multiple JWT algorithms automatically.
3. Attaches `{ ...user, sub: user.id }` to `request.user`. Use `request.user.sub` as the user UUID everywhere.

**Public routes** have no auth hook. **The Paystack webhook** has no auth hook but validates the HMAC-SHA512 signature instead.

---

## Route Map

### Public (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — Railway uses this |
| `GET` | `/spaces/by-slug/:slug` | Fetch published space by slug or UUID |
| `GET` | `/billing/plans` | List plans (in-memory cached 5 min) |
| `POST` | `/analytics/view` | Increment daily view counter |
| `POST` | `/leads` | Submit lead inquiry from a public space |
| `POST` | `/billing/webhook/paystack` | Paystack webhook (HMAC verified) |

### Protected (Bearer JWT)

| Method | Path | Description |
|---|---|---|
| `GET` | `/spaces` | List user's spaces |
| `POST` | `/spaces` | Create space (quota-checked) |
| `GET` | `/spaces/:id` | Get space with media + 360 settings |
| `PATCH` | `/spaces/:id` | Update space metadata |
| `DELETE` | `/spaces/:id` | Delete space + R2 cleanup + quota decrement |
| `POST` | `/spaces/:id/publish` | Publish/unpublish (subscription + entitlement checks) |
| `POST` | `/uploads/create-signed-url` | Generate R2 presigned PUT URL (quota-checked) |
| `POST` | `/uploads/complete` | Register media record after upload |
| `DELETE` | `/uploads/:id` | Delete media from R2 + DB + decrement storage |
| `POST` | `/billing/initialize-paystack` | Init Paystack transaction |
| `GET` | `/billing/status` | Current subscription + plan + usage |
| `GET` | `/analytics/summary` | Views across all user spaces |
| `GET` | `/analytics/summary/:id` | Last 30d for one space |
| `GET` | `/leads` | All leads across user's spaces |
| `GET` | `/leads/space/:id` | Leads for a specific space |
| `GET` | `/dashboard/summary` | Aggregated dashboard home data |
| `GET/PATCH` | `/profile` | User profile row |

---

## Quota System — CRITICAL

**All write operations must go through `src/utils/quotas.ts` before executing.**

```
checkUserQuota(fastify, userId) → { plan, subscription, canWrite, isGrace, isFree }
```

| Status | `canWrite` | `isGrace` | Meaning |
|---|---|---|---|
| `active`, `trialing`, `trial` | true | false | Full access |
| `grace_period`, `past_due` | false | true | Reads OK, writes blocked |
| `expired`, `canceled` | false | false | Fully blocked |

- `canCreateSpace(fastify, userId)` — checks `active_properties_count` vs `plan.max_active_spaces`
- `checkStorageQuota(fastify, userId, fileSize)` — checks cumulative vs `plan.max_storage_bytes`
- `checkFileSizeLimit(plan, fileSize)` — single file vs `plan.max_upload_bytes` (default 15 MB)
- `isValidFileType(contentType, mediaType)` — only JPEG, PNG, WebP

---

## The "Properties vs Spaces" Naming Convention

**This is the most important thing to know before editing any route.**

- Database table: `properties`
- Database column: `property_type`
- API response field: `space_type` (not `property_type`)

Every route handler maps this manually:
```ts
const mappedSpace = {
  ...data,
  space_type: data.property_type,
  property_type: undefined     // strip from response
}
```

**Never expose `property_type` in an API response. Always map it to `space_type`.**

---

## Upload Flow

1. `POST /uploads/create-signed-url` — quota check, ownership check, generate R2 presigned URL.
2. Browser uploads file **directly to R2** (never through this server).
3. `POST /uploads/complete` — insert `property_media` row, increment storage counter.

R2 object key pattern:
```
users/{userId}/spaces/{spaceId}/panorama/{ts}-{rand}.jpg
users/{userId}/spaces/{spaceId}/gallery/{ts}-{rand}.jpg
users/{userId}/spaces/{spaceId}/thumb/{ts}-{rand}.jpg
users/{userId}/branding/{ts}-{rand}.png
```

---

## Billing / Paystack Webhook Flow

1. App initiates `POST /billing/initialize-paystack` → backend calls Paystack API → returns `{ authorization_url }`.
2. User completes payment on Paystack.
3. Paystack sends `POST /billing/webhook/paystack` to this server.
4. Backend verifies HMAC-SHA512 signature, acks with `200` immediately, then processes async.
5. On `charge.success` → upsert `subscriptions` row with `status: 'active'`, set `grace_period_ends_at` = end + 7 days.
6. On `subscription.disable` / `invoice.payment_failed` → set `status: 'past_due'`.

---

## Database Tables (inferred from code)

| Table | Key Columns |
|---|---|
| `profiles` | `id`, `email`, `full_name`, `avatar_url`, `agency_name`, `agency_logo_url` |
| `properties` | `id`, `user_id`, `title`, `slug`, `property_type`, `is_published`, `lead_form_enabled`, `branding_enabled` |
| `property_media` | `id`, `property_id`, `media_type` (`panorama`/`gallery_image`/`thumbnail`), `storage_key`, `public_url`, `file_size_bytes` |
| `property_360_settings` | `id`, `property_id`, `panorama_media_id`, `hfov_default`, `pitch_default`, `yaw_default`, `auto_rotate_enabled`, `hotspots_json` |
| `plans` | `id`, `name`, `price_monthly_kes`, `price_yearly_kes`, `max_active_properties`, `max_storage_bytes`, `max_upload_bytes`, `lead_capture_enabled`, `branding_customization_enabled`, `embeds_enabled`, `qr_download_enabled`, `advanced_analytics_enabled`, `max_team_members` |
| `subscriptions` | `id`, `user_id`, `plan_id`, `status`, `billing_cycle`, `current_period_end`, `grace_period_ends_at` |
| `usage_counters` | `user_id`, `active_properties_count`, `storage_used_bytes` |
| `leads` | `id`, `property_id`, `name`, `email`, `phone`, `message`, `source` |
| `analytics_daily` | `property_id`, `date`, `total_views`, `direct_views`, `qr_views`, `embed_views` |

**Supabase RPCs required:**

| RPC | Called when |
|---|---|
| `increment_active_properties(u_id)` | Space created |
| `decrement_active_properties(u_id)` | Space deleted |
| `increment_storage_usage(u_id, bytes)` | Upload completed |
| `increment_daily_views(prop_id, event_date, view_source)` | Public space viewed |
| `increment_daily_leads(prop_id, event_date)` | Lead submitted |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service-role key (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | ✅ | JWT secret from Supabase → Settings → API |
| `R2_ACCOUNT_ID` | ✅ | Cloudflare account ID |
| `R2_BUCKET_NAME` | ✅ | R2 bucket name |
| `R2_ACCESS_KEY_ID` | ✅ | R2 access key |
| `R2_SECRET_ACCESS_KEY` | ✅ | R2 secret key |
| `MEDIA_DOMAIN` | — | Public CDN domain (e.g. `https://media.viewora.software`) |
| `PAYSTACK_SECRET_KEY` | — | Paystack secret key |
| `APP_URL` | — | Dashboard URL for Paystack callback |
| `CORS_ORIGIN` | — | Comma-separated allowed origins |
| `PORT` | — | Server port (default: 3000) |

Server **exits on startup** if any of the first 7 required vars are missing.

---

## Known Gaps / Incomplete Work

| Area | Status |
|---|---|
| Zod validation | Installed but minimally used — most route bodies cast as `any`. Add schemas to new routes. |
| QR code routes | Plan flags exist (`qr_download_enabled`, `qr_svg_enabled`) — no routes implemented. |
| Team members | Plan has `max_team_members` — no invite/team feature implemented. |
| Hotspots | `hotspots_json` field exists — no route to save/read hotspot data. |
| Grace period auto-unpublish | Expired subscriptions are not auto-unpublished — would need a cron or Railway scheduler. |
| Rate limiting on public routes | Global 100 req/min applied, but `/analytics/view` and `/leads` public routes have no per-IP fine-grained limiting. |
| Test coverage | None. |

---

## Coding Rules for AI Editing This Repo

1. **Quota before every write** — call `checkUserQuota()` before create/upload/publish. Never skip this.
2. **Map `property_type` → `space_type`** on every response. Strip `property_type` from output.
3. **Scope all queries to `user_id`** — the service-role client bypasses RLS. Manually add `.eq('user_id', userId)` or equivalent to prevent cross-user data leaks.
4. **Delete R2 objects before deleting DB records** — order matters, R2 deletion is best-effort but must be attempted.
5. **Public routes before the auth hook** — in a plugin, register public routes before calling `fastify.addHook('preHandler', fastify.authenticate)`.
6. **Ack Paystack webhook before processing** — always `reply.code(200).send()` first, then process the event asynchronously.
7. **Use `reply.code(4xx).send({ statusMessage: '...' })`** for client errors — the frontend maps `statusMessage` to display text.
