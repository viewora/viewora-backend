# Fastify Plugins

Shared global logic and service integrations injected into the Fastify lifecycle.

## 🔌 Core Plugins
- **`auth.ts`**: Decorates `fastify.authenticate`. Verifies Bearer tokens by calling `supabase.auth.getUser(token)` — not by parsing the JWT locally. This handles key rotation and algorithm differences automatically.
- **`supabase.ts`**: Provides a global `fastify.supabase` client for database operations.
- **`s3.ts`**: Configures the S3-compatible client for R2 storage (AWS SDK v3).

## 🛠️ Dev Notes
These plugins are registered in `src/index.ts` and become available on the `fastify` instance throughout the application.

## 💡 Guidelines
- Keep plugins **lightweight**. Avoid adding complex business logic here; move it to `utils/`.
- Ensure proper environment variable validation before initializing third-party clients (S3/Supabase).
