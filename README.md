# Viewora Backend

Fastify REST API for the Viewora platform. Deployed on Railway.

## Development

```bash
cp .env.example .env
# fill in your values
npm install
npm run dev
```

## Production

Deployed automatically to Railway on push to `main`.

Set all env vars from `.env.example` in the Railway dashboard.

## API Routes

- `GET  /health`
- `GET  /billing/plans`
- `POST /billing/initialize-paystack`
- `POST /billing/webhook/paystack`
- `GET  /billing/subscription-status`
- `GET  /properties/by-slug/:slug`
- `POST /properties`
- `PATCH /properties/:id`
- `DELETE /properties/:id`
- `POST /properties/:id/publish`
- `POST /uploads/create-signed-url`
# Viewora Backend (Fastify/Node.js)

High-performance, secure REST API providing the backbone for the Viewora platform.

## 🚀 Architecture
Built with **Fastify** for speed and **TypeScript** for type safety. The backend integrates directly with:
- **Supabase**: PostgreSQL database and Auth provider.
- **R2 (Cloudflare)**: High-speed S3-compatible media storage.
- **Paystack**: Payment processing.

## 📁 Key Directories
- **`/src/plugins`**: Shared logic (Auth, DB, S3) injected into the Fastify instance.
- **`/src/routes`**: Domain-driven API modules (Spaces, Leads, Analytics, Billing).
- **`/src/utils`**: Business logic helpers (Quota management, file validation).

## 🛠️ Implementation Patterns
- **Standardized Responses**: Always return structured JSON. Use `reply.code(4xx).send({ statusMessage: '...' })`.
- **JWT Auth**: All protected routes must use the `{ preHandler: [fastify.authenticate] }` hook.
- **Supabase RPCs**: Complex data operations (like incrementing usage) are handled via PostgreSQL stored procedures (RPCs).

## 💡 Guidelines for Agents
1.  **Quotas**: Before performing write operations (uploading media / creating spaces), always verify the user's quota using `src/utils/quotas.ts`.
2.  **Storage Integrity**: When deleting a property, always ensure the corresponding media files are deleted from the R2 bucket.
3.  **Validation**: Use **Zod** or Fastify schemas to validate incoming request bodies.
