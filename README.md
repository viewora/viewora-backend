# viewora-backend

Fastify REST API for the Viewora platform. Written in TypeScript, deployed on Railway. All business logic, quota enforcement, subscription management, and media storage orchestration live here.

> **Standalone repo** — separate GitHub repository, deployed independently to **Railway**. No shared code with `viewora-app` or `viewora-marketing`.


---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js ≥ 22 |
| Framework | Fastify 5 |
| Language | TypeScript (compiled via `tsc`, dev via `tsx`) |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` |
| Auth | Supabase JWT verification (`supabase.auth.getUser(token)`) |
| Storage | Cloudflare R2 via `@aws-sdk/client-s3` (S3-compatible) |
| Billing | Paystack via `axios` HTTP calls |
| Validation | Zod (installed; use for schema validation on new routes) |
| Deployment | Railway (Nixpacks) |

---

## Folder Structure

```
viewora-backend/
├── src/
│   ├── index.ts              # Entry point: registers plugins, routes, starts server
│   │
│   ├── plugins/
│   │   ├── auth.ts           # fastify.authenticate decorator (Supabase JWT verification)
│   │   ├── supabase.ts       # fastify.supabase decorator (service-role client)
│   │   └── s3.ts             # fastify.s3 decorator (R2/S3 client)
│   │
│   ├── routes/
│   │   ├── spaces.ts         # /spaces — CRUD + publish, quota-gated
│   │   ├── uploads.ts        # /uploads — presigned URL generation + complete registration
│   │   ├── billing.ts        # /billing — plans, Paystack init, webhook handler
│   │   ├── analytics.ts      # /analytics — view tracking + daily summary
│   │   ├── leads.ts          # /leads — lead submission + retrieval
│   │   ├── dashboard.ts      # /dashboard/summary — home screen aggregation
│   │   ├── profile.ts        # /profile — user profile read/write
│   │   └── maintenance.ts    # /maintenance — admin-only operational scripts
│   │
│   └── utils/
│       └── quotas.ts         # Quota checking: canCreateSpace, checkStorageQuota, checkUserQuota
│
├── railway.json              # Railway deployment config (build + health check)
├── tsconfig.json
├── .env.example
└── package.json
```

---

## API Routes

### Public (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service info |
| `GET` | `/health` | Health check (used by Railway) |
| `GET` | `/spaces/by-slug/:slug` | Fetch a published space by slug or UUID |
| `GET` | `/billing/plans` | List all subscription plans (cached 5 min) |
| `POST` | `/analytics/view` | Increment view count for a space |
| `POST` | `/leads` | Submit a lead inquiry for a space |
| `POST` | `/billing/webhook/paystack` | Paystack webhook (HMAC-verified, no auth) |

### Protected (Bearer JWT required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/spaces` | List user's spaces |
| `POST` | `/spaces` | Create a space (quota-checked) |
| `GET` | `/spaces/:id` | Get single space with media + 360 settings |
| `PATCH` | `/spaces/:id` | Update space metadata |
| `DELETE` | `/spaces/:id` | Delete space + cascade R2 cleanup + quota decrement |
| `POST` | `/spaces/:id/publish` | Publish / unpublish (subscription + entitlement checked) |
| `POST` | `/uploads/create-signed-url` | Generate R2 presigned PUT URL (quota-checked) |
| `POST` | `/uploads/complete` | Register uploaded media + increment storage counter |
| `DELETE` | `/uploads/:id` | Delete media from R2 + DB + decrement storage |
| `POST` | `/billing/initialize-paystack` | Init Paystack transaction |
| `GET` | `/billing/status` | Current subscription + plan + usage counters |
| `GET` | `/analytics/summary` | Total view stats across all user spaces |
| `GET` | `/analytics/summary/:id` | Last 30 days stats for a specific space |
| `GET` | `/leads` | All leads across user's spaces |
| `GET` | `/leads/space/:id` | Leads for a specific space |
| `GET` | `/dashboard/summary` | Aggregated home dashboard data |
| `GET` | `/profile` | User profile row |
| `PATCH` | `/profile` | Update user profile |

---

## Key Files Explained

### `src/index.ts`

Server entry point. Registers CORS (configurable via `CORS_ORIGIN`), rate limiting (100 req/min), JWT plugin, and the three core plugins (auth, supabase, s3). All routes are registered with explicit prefixes. Fails fast on startup if any required env vars are missing. Also provides a `/plans` → `/billing/plans` redirect for backward compatibility.

### `src/plugins/auth.ts`

Decorates Fastify with `fastify.authenticate`. Extracts the Bearer token from `Authorization` header, calls `fastify.supabase.auth.getUser(token)` to verify it (this handles ES256/HS256 and key rotation), then attaches `{ ...user, sub: user.id }` to `request.user`. All protected routes use `{ preHandler: [fastify.authenticate] }` or `fastify.addHook('preHandler', fastify.authenticate)`.

### `src/plugins/supabase.ts`

Creates a Supabase client using the **service-role key** (not the anon key). This bypasses RLS and is required for server-side operations like updating subscriptions, reading cross-user data, etc. The client has `autoRefreshToken: false` and `persistSession: false` since it's server-side.

### `src/utils/quotas.ts`

Central quota enforcement. All write endpoints call this before proceeding.

- `checkUserQuota(fastify, userId)` → returns `{ plan, subscription, canWrite, isGrace, isFree }`. Grace period (past_due) blocks writes but allows reads. Expired grace blocks everything.
- `canCreateSpace(fastify, userId)` → checks `active_properties_count` vs `plan.max_active_spaces`.
- `checkStorageQuota(fastify, userId, newFileSize)` → checks current storage usage vs `plan.max_storage_bytes`.
- `checkFileSizeLimit(plan, fileSize)` → single file size check against `plan.max_upload_bytes` (default 15 MB).
- `isValidFileType(contentType, mediaType)` → only allows JPEG, PNG, WebP.

### `src/routes/billing.ts`

Paystack webhook flow: verifies HMAC-SHA512 signature, acks Paystack immediately with `200`, then processes async. On `charge.success` / `subscription.create`, upserts a `subscriptions` row with `status: 'active'` and a 7-day grace period end date. On `subscription.disable` / `invoice.payment_failed`, moves status to `past_due`.

### `src/routes/spaces.ts`

The database model uses the column name `property_type`, but the API exposes it as `space_type`. The `property_type` key is stripped from all responses. This normalization happens manually in every route handler (`space_type: data.property_type, property_type: undefined`).

---

## Database Schema (inferred from code)

| Table | Key Columns |
|---|---|
| `profiles` | `id`, `email`, `full_name`, `avatar_url`, `phone`, `agency_name`, `agency_logo_url` |
| `properties` | `id`, `user_id`, `title`, `slug`, `description`, `property_type`, `location_text`, `cover_image_url`, `has_360`, `has_gallery`, `is_published`, `published_at`, `visibility`, `lead_form_enabled`, `branding_enabled` |
| `property_media` | `id`, `property_id`, `media_type` (`panorama`/`gallery_image`/`thumbnail`), `storage_key`, `public_url`, `width`, `height`, `file_size_bytes`, `sort_order`, `is_primary` |
| `property_360_settings` | `id`, `property_id` (FK), `panorama_media_id`, `hfov_default`, `pitch_default`, `yaw_default`, `auto_rotate_enabled`, `hotspots_json` |
| `plans` | `id`, `name`, `price_monthly_kes`, `price_yearly_kes`, `max_active_properties`, `max_storage_bytes`, `max_upload_bytes`, `lead_capture_enabled`, `branding_customization_enabled`, `embeds_enabled`, `advanced_embeds_enabled`, `qr_download_enabled`, `advanced_analytics_enabled`, `max_team_members` |
| `subscriptions` | `id`, `user_id`, `plan_id`, `status`, `billing_cycle`, `current_period_start`, `current_period_end`, `grace_period_ends_at`, `provider`, `provider_reference` |
| `usage_counters` | `user_id`, `active_properties_count`, `storage_used_bytes` |
| `leads` | `id`, `property_id`, `name`, `email`, `phone`, `message`, `source`, `created_at` |
| `analytics_daily` | `id`, `property_id`, `date`, `total_views`, `direct_views`, `qr_views`, `embed_views` |

**Supabase RPCs used:**
- `increment_active_properties(u_id)` — called on space create
- `decrement_active_properties(u_id)` — called on space delete
- `increment_storage_usage(u_id, bytes)` — called on upload complete
- `increment_daily_views(prop_id, event_date, view_source)` — called on public space view
- `increment_daily_leads(prop_id, event_date)` — called on lead submission

---

## Upload Flow

1. Client calls `POST /uploads/create-signed-url` with `{ spaceId, mediaType, fileName, contentType, fileSize }`.
2. Backend validates quota, file type, file size. Generates an R2 presigned PUT URL (expires in 1 hour).
3. Backend returns `{ signedUrl, objectKey, publicUrl }`.
4. Client uploads the file directly to R2 via `PUT signedUrl`.
5. Client calls `POST /uploads/complete` with `{ spaceId, mediaType, objectKey, publicUrl, width, height, fileSize }`.
6. Backend inserts a `property_media` row and increments storage counters.

Object keys follow the pattern: `users/{userId}/spaces/{spaceId}/{folder}/{timestamp}-{random}.{ext}`

---

## Coding Conventions

- **Error responses**: Use `reply.code(4xx).send({ statusMessage: 'Human-readable message' })` for client errors.
- **Auth on route groups**: Use `fastify.addHook('preHandler', fastify.authenticate)` at the top of a plugin for blanket protection, or `{ preHandler: [fastify.authenticate] }` per-route for mixed public/private.
- **Never mix concerns**: Public routes (e.g., `GET /spaces/by-slug/:slug`) must be registered **before** the blanket auth hook in the same plugin.
- **Quota before every write**: Always call `checkUserQuota` before create/upload/publish operations.
- **Storage cleanup on delete**: Always delete R2 objects before deleting DB records.

---

## Setup & Run

```bash
cp .env.example .env
# Fill in all required vars (see .env.example)

npm install
npm run dev     # tsx watch mode on :3000
```

### Build for production:
```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service-role key |
| `SUPABASE_JWT_SECRET` | ✅ | JWT secret (from Supabase project settings) |
| `R2_ACCOUNT_ID` | ✅ | Cloudflare account ID |
| `R2_BUCKET_NAME` | ✅ | R2 bucket name (e.g., `viewora-tours`) |
| `R2_ACCESS_KEY_ID` | ✅ | R2 access key |
| `R2_SECRET_ACCESS_KEY` | ✅ | R2 secret key |
| `MEDIA_DOMAIN` | — | Public CDN domain (e.g., `https://media.viewora.software`) |
| `PAYSTACK_SECRET_KEY` | — | Paystack secret key (skip for local dev without billing) |
| `APP_URL` | — | Dashboard URL for Paystack callback redirect |
| `CORS_ORIGIN` | — | Comma-separated allowed origins |
| `PORT` | — | Server port (default: 3000) |

---

## Deployment

Deployed to **Railway** via Nixpacks. Config defined in `railway.json`:
- Build: `npm run build`
- Start: `node dist/index.js`
- Health check: `GET /health` (timeout 30s)
- Restart policy: On failure, max 3 retries
