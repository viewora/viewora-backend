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
- `POST /uploads/complete`
- `POST /leads`
- `GET  /leads`
- `GET  /leads/property/:id`
- `POST /analytics/view`
- `GET  /analytics/summary`
- `GET  /analytics/summary/:id`
