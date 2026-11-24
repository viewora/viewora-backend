import { z } from 'zod'
import { listingInputSchema, listingPatchSchema, AVAILABILITY, PUBLICATION_STATUSES, MEDIA_KINDS } from './listingModel.js'
import { EVENT_TYPES } from './webhooks.js'
import { SCOPES } from './scopes.js'
import { claimBody } from './claims.js'

// The OpenAPI description of /v1, generated from the same zod schemas the
// API validates with, so the two cannot drift. Served at GET /v1/openapi.json
// and written to docs/ by `npm run partner:openapi`.

const schemaOf = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete j.$schema
  return j
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object) => ({ 'application/json': { schema } })
const errorResponse = (description: string) => ({ description, content: json(ref('Error')) })
const idParam = { name: 'id', in: 'path', required: true, description: 'lst_<uuid>, or ext:<your external_id>', schema: { type: 'string' } }
const idemHeader = { name: 'Idempotency-Key', in: 'header', required: false, description: 'A UUID. Retrying with the same key and body returns the first answer (24 hours).', schema: { type: 'string', maxLength: 255 } }

type Op = { summary: string; scope: string; description?: string; parameters?: object[]; body?: object; responses: Record<string, object> }
const op = (o: Op) => ({
  summary: o.summary,
  description: [o.description, `Scope: \`${o.scope}\``].filter(Boolean).join('\n\n'),
  security: [{ partnerKey: [] }],
  ...(o.parameters ? { parameters: o.parameters } : {}),
  ...(o.body ? { requestBody: { required: true, content: json(o.body) } } : {}),
  responses: { ...o.responses, 401: errorResponse('Missing, invalid, revoked or expired key'), 403: errorResponse('Partner suspended or scope missing'), 429: errorResponse('Rate limited') },
})

export function buildOpenApi() {
  const listing = { type: 'object', properties: { listing: ref('Listing'), applied: { type: 'boolean' }, changed: { type: 'boolean' } } }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Viewora Partner API',
      version: '1.0.0',
      description: [
        'Send your property and vehicle listings to Viewora. Your system owns the listing facts; Viewora owns tours, pages and moderation.',
        'Money is always an integer: whole KES, or USD cents. Timestamps are ISO 8601 UTC. Unknown fields are refused.',
        'Every response has an X-Request-Id header; quote it when you contact support.',
      ].join('\n\n'),
    },
    servers: [{ url: 'https://api.viewora.software/v1' }],
    components: {
      securitySchemes: { partnerKey: { type: 'http', scheme: 'bearer', description: 'vo_test_… (sandbox) or vo_live_…' } },
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: {
            code: { type: 'string' }, message: { type: 'string' },
            fields: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          } } },
        },
        ListingInput: schemaOf(listingInputSchema),
        ListingPatch: schemaOf(listingPatchSchema),
        Listing: {
          allOf: [ref('ListingInput')],
          type: 'object',
          properties: {
            id: { type: 'string', example: 'lst_6f1c…' }, tour_id: { type: 'string', format: 'uuid' }, version: { type: 'integer' },
            publication_status: { enum: [...PUBLICATION_STATUSES] },
            moderation: { type: 'object', properties: { reasons: { type: 'array', items: { type: 'object' } }, pending_change: { type: 'boolean' } } },
            media: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { enum: [...MEDIA_KINDS] }, source_url: { type: 'string' }, status: { enum: ['pending', 'fetching', 'ready', 'failed', 'skipped'] } } } },
            urls: { type: 'object', properties: { share: { type: ['string', 'null'] }, embed: { type: ['string', 'null'] } } },
            published_at: { type: ['string', 'null'] }, expires_at: { type: ['string', 'null'] }, archived_at: { type: ['string', 'null'] },
            restore_until: { type: ['string', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
          },
        },
        WebhookEvent: {
          type: 'object',
          description: 'POSTed to your endpoint. Check Viewora-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body"> with your secret, and refuse anything older than 5 minutes. Delivery is at least once and not ordered: use id to drop repeats and data.listing.version to drop stale events.',
          properties: { id: { type: 'string' }, type: { enum: [...EVENT_TYPES, 'webhook.test'] }, created_at: { type: 'string' }, mode: { enum: ['test', 'live'] }, data: { type: 'object' } },
        },
      },
    },
    'x-scopes': SCOPES,
    paths: {
      '/listings': {
        post: op({ summary: 'Create a listing', scope: 'listings:write', parameters: [idemHeader], body: ref('ListingInput'),
          description: 'Synchronous. Media sent by source_url are fetched in the background; the listing goes live when they are ready.',
          responses: { 201: { description: 'Created', content: json(listing) }, 400: errorResponse('VALIDATION_ERROR'), 404: errorResponse('AGENT_NOT_FOUND'), 409: errorResponse('LISTING_EXISTS'), 422: errorResponse('IDEMPOTENCY_KEY_REUSED') } }),
        get: op({ summary: 'List your listings', scope: 'listings:read',
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'external_id', in: 'query', schema: { type: 'string' } },
            { name: 'agent_external_id', in: 'query', schema: { type: 'string' } },
            { name: 'availability', in: 'query', schema: { enum: [...AVAILABILITY] } },
            { name: 'publication_status', in: 'query', schema: { enum: [...PUBLICATION_STATUSES] } },
            { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'sort', in: 'query', schema: { enum: ['updated_at', '-updated_at', 'created_at', '-created_at'], default: '-updated_at' } },
          ],
          responses: { 200: { description: 'A page', content: json({ type: 'object', properties: { data: { type: 'array', items: ref('Listing') }, next_cursor: { type: ['string', 'null'] } } }) }, 400: errorResponse('INVALID_FILTER or INVALID_CURSOR') } }),
      },
      '/listings/{id}': {
        get: op({ summary: 'Read one listing', scope: 'listings:read', parameters: [idParam], responses: { 200: { description: 'The listing', content: json({ type: 'object', properties: { listing: ref('Listing') } }) }, 404: errorResponse('LISTING_NOT_FOUND (also for other partners\' ids)') } }),
        patch: op({ summary: 'Update partner-owned fields', scope: 'listings:write',
          description: 'Send only what changed. Sending media replaces the media list. If-Match: <version> is recommended. An update whose partner_updated_at is older than the stored one is ignored (applied: false, reason: stale). On a live listing, a price drop over 30%, a currency change or a 3rd change in 24 hours is held for review (202).',
          parameters: [idParam, idemHeader, { name: 'If-Match', in: 'header', schema: { type: 'string' } }], body: ref('ListingPatch'),
          responses: { 200: { description: 'Updated (or unchanged / stale)', content: json(listing) }, 202: { description: 'Held for review', content: json(listing) }, 409: errorResponse('VERSION_CONFLICT, FIELD_OWNED_BY_OTHER, FIELD_IMMUTABLE, LISTING_ARCHIVED'), 423: errorResponse('LISTING_LOCKED') } }),
        delete: op({ summary: 'Withdraw and archive (restorable for 30 days)', scope: 'listings:write', parameters: [idParam, idemHeader],
          body: { type: 'object', properties: { reason: { type: 'string' }, confirm_bulk_delete: { type: 'boolean' } } },
          responses: { 200: { description: 'Archived', content: json(listing) }, 409: errorResponse('BULK_DELETE_HELD') } }),
      },
      '/listings/{id}/restore': { post: op({ summary: 'Undo an archive', scope: 'listings:write', parameters: [idParam, idemHeader], responses: { 200: { description: 'Restored', content: json(listing) }, 410: errorResponse('RESTORE_WINDOW_PASSED') } }) },
      '/listings/bulk': { post: op({ summary: 'Upsert up to 500 listings (asynchronous)', scope: 'listings:write', parameters: [idemHeader],
        description: 'An item whose external_id exists is a partial update; otherwise it is created. dry_run checks every item without writing.',
        body: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 500, items: { type: 'object' } }, mode: { const: 'upsert' }, dry_run: { type: 'boolean' } } },
        responses: { 202: { description: 'Queued', content: json({ type: 'object', properties: { import_id: { type: 'string' }, status: { type: 'string' }, items_received: { type: 'integer' }, status_url: { type: 'string' } } }) }, 413: errorResponse('TOO_MANY_ITEMS'), 429: errorResponse('IMPORT_CONCURRENCY') } }) },
      '/imports/{id}': { get: op({ summary: 'Import progress and per-row errors', scope: 'listings:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Progress' }, 404: errorResponse('IMPORT_NOT_FOUND') } }) },
      '/listings/reconcile': { post: op({ summary: 'Compare your active listings with Viewora\'s', scope: 'listings:read',
        description: 'Changes nothing. Lists listings Viewora holds that you did not send, ids Viewora does not know, and versions you are behind on.',
        body: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { external_id: { type: 'string' }, version: { type: 'integer' } } } } } },
        responses: { 200: { description: 'Differences' } } }) },
      '/media': { post: op({ summary: 'Add one file by URL to a listing', scope: 'media:write', parameters: [idemHeader],
        description: 'The file is fetched in the background (https only, public addresses, 25 MB photos, 60 MB panoramas). Files on your computer: use POST /tours/{tour_id}/uploads.',
        body: { type: 'object', required: ['listing_id', 'kind', 'source_url'], properties: { listing_id: { type: 'string' }, kind: { enum: [...MEDIA_KINDS] }, source_url: { type: 'string' }, caption: { type: 'string' }, angle: { type: 'integer' }, order: { type: 'integer' } } },
        responses: { 202: { description: 'Queued' }, 404: errorResponse('LISTING_NOT_FOUND') } }) },
      '/webhooks': {
        post: op({ summary: 'Register an endpoint', scope: 'webhooks:manage', body: { type: 'object', required: ['url', 'events'], properties: { url: { type: 'string' }, events: { type: 'array', items: { enum: [...EVENT_TYPES, '*'] } } } },
          responses: { 201: { description: 'Created; the secret is shown once' }, 400: errorResponse('URL_NOT_HTTPS or URL_PRIVATE_NETWORK'), 409: errorResponse('WEBHOOK_LIMIT') } }),
        get: op({ summary: 'List endpoints', scope: 'webhooks:manage', responses: { 200: { description: 'Endpoints' } } }),
      },
      '/webhooks/{id}': { delete: op({ summary: 'Delete an endpoint', scope: 'webhooks:manage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' } } }) },
      '/webhooks/{id}/test': { post: op({ summary: 'Send a webhook.test event', scope: 'webhooks:manage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: { description: 'Queued' } } }) },
      '/webhooks/{id}/enable': { post: op({ summary: 'Switch a disabled endpoint back on', scope: 'webhooks:manage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Enabled' } } }) },
      '/webhooks/{id}/rotate-secret': { post: op({ summary: 'New signing secret; the old one keeps signing for 24 hours', scope: 'webhooks:manage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The new secret, shown once' } } }) },
      '/claims': {
        post: op({ summary: 'Ask an agent to let you manage a tour they made in the Viewora app', scope: 'listings:write', parameters: [idemHeader],
          description: 'The agent approves or declines in the app (claim.approved / claim.declined events; claims expire after 14 days). After approval, POST /v1/listings with the same external_id puts your listing on that tour.',
          body: schemaOf(claimBody), responses: { 201: { description: 'Waiting for the agent' }, 404: errorResponse('AGENT_NOT_FOUND, TOUR_NOT_FOUND'), 409: errorResponse('CLAIM_EXISTS, TOUR_ALREADY_LINKED, LISTING_EXISTS') } }),
        get: op({ summary: 'Your claims', scope: 'listings:read', parameters: [{ name: 'status', in: 'query', schema: { enum: ['pending', 'approved', 'declined', 'cancelled', 'expired'] } }], responses: { 200: { description: 'Claims' } } }),
      },
      '/claims/{id}': {
        get: op({ summary: 'One claim', scope: 'listings:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The claim' }, 404: errorResponse('CLAIM_NOT_FOUND') } }),
        delete: op({ summary: 'Withdraw a claim that is still waiting', scope: 'listings:write', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Cancelled' }, 409: errorResponse('CLAIM_NOT_PENDING') } }),
      },
      '/webhooks/{id}/deliveries': { get: op({ summary: 'Last 50 deliveries', scope: 'webhooks:manage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deliveries' } } }) },
      '/leads': { get: op({ summary: 'Leads for your listings', scope: 'leads:read', description: 'Granted only after the data-processing addendum is signed. Only buyers who agreed to share their details with you are listed, each with the exact consent wording. Every read is logged.',
        parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'listing_id', in: 'query', schema: { type: 'string' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }],
        responses: { 200: { description: 'A page of leads' } } }) },
      '/analytics': { get: op({ summary: 'Views per listing per day (at most 92 days)', scope: 'analytics:read',
        parameters: [{ name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'listing_id', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'Series' }, 400: errorResponse('RANGE_TOO_LARGE') } }) },
      '/export/listings': { get: op({ summary: 'Read-only feed of your agents\' published tours, including ones made in the Viewora app', scope: 'listings:read',
        parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'A page' } } }) },
    },
    webhooks: { listingEvent: { post: { requestBody: { content: json(ref('WebhookEvent')) }, responses: { 200: { description: 'Any 2xx acknowledges the event' } } } } },
  }
}

/** A Postman collection (v2.1) for the same endpoints, with a sandbox key variable. */
export function buildPostman(spec = buildOpenApi()) {
  const items: object[] = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, o] of Object.entries(methods as Record<string, any>)) {
      const url = `{{baseUrl}}${path.replace(/\{(\w+)\}/g, ':$1')}`
      items.push({
        name: o.summary,
        request: {
          method: method.toUpperCase(),
          header: [{ key: 'Content-Type', value: 'application/json' }, ...(method === 'post' || method === 'patch' || method === 'delete' ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : [])],
          url: { raw: url, host: ['{{baseUrl}}'], path: path.split('/').filter(Boolean).map(p => p.replace(/\{(\w+)\}/g, ':$1')) },
          ...(o.requestBody ? { body: { mode: 'raw', raw: '{}' } } : {}),
          description: o.description,
        },
      })
    }
  }
  return {
    info: { name: 'Viewora Partner API v1', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }] },
    variable: [{ key: 'baseUrl', value: 'https://api.viewora.software/v1' }, { key: 'apiKey', value: 'vo_test_your_sandbox_key' }],
    item: items,
  }
}
