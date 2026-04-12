# API Routes

This folder contains the domain-driven API modules for Viewora.

- **`spaces.ts`**: Properties CRUD + publishing logic. Note: DB table is `properties`, but API exposes `space_type` (not `property_type`).
- **`uploads.ts`**: Presigned R2 URL generation, upload completion registration, and media deletion.
- **`leads.ts`**: Prospect capture and retrieval by space or user.
- **`analytics.ts`**: Daily view tracking (public) and aggregated metrics (authenticated).
- **`billing.ts`**: Subscription lifecycle, plan listing (in-memory cached), and Paystack webhook handling.
- **`dashboard.ts`**: Aggregated home dashboard summary (spaces, views, leads).
- **`profile.ts`**: User profile row read/update.
- **`maintenance.ts`**: Admin-only sync endpoint (key-protected, not JWT-protected).

## 🛠️ Routing Patterns
- **Namespacing**: Routes are grouped by entity.
- **Hooks**: Common logic (like owner verification) is implemented as Fastify prehandlers.
- **RPC Usage**: Frequently calls Supabase RPCs (e.g., `increment_active_properties`) for ACID-compliant usage tracking.

## 💡 Guidelines
- Always verify **Ownership** before allowing PATCH or DELETE operations on a resource.
- Ensure that the `leads` routes correctly handle the `status` field added in the production schema sync.
