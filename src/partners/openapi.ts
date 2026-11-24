import { z } from 'zod'
import { listingInputSchema, listingPatchSchema, AVAILABILITY, PUBLICATION_STATUSES, MEDIA_KINDS } from './listingModel.js'
import { EVENT_TYPES } from './webhooks.js'
import { SCOPES } from './scopes.js'
import { claimBody } from './claims.js'
import { createAgentBody, createTourBody, createUploadBody, completeUploadBody, SPACE_TYPES, FACT_KEYS } from './v1Schemas.js'
import { guideMarkdown } from './docsGuide.js'

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

// Sidebar groups for /docs. Each path's first segment picks its tag.
const TAGS: Record<string, { name: string; description: string }> = {
  agents: { name: 'Agents', description: 'Each agent or dealer is their own Viewora account, paid for by you.' },
  tours: { name: 'Tours and uploads', description: 'Create a tour, upload photos and 360° panoramas from your server, publish and embed.' },
  listings: { name: 'Listings', description: 'Send whole listings (price, availability, location, photos by URL) and keep them in sync.' },
  imports: { name: 'Listings', description: '' },
  media: { name: 'Listings', description: '' },
  webhooks: { name: 'Webhook endpoints', description: 'Register and manage the URLs Viewora sends events to. How to check signatures is under Receiving events in the guide.' },
  claims: { name: 'Claims', description: 'Ask to manage a tour an agent made in the Viewora app.' },
  leads: { name: 'Leads and analytics', description: 'Buyers who agreed to share their details, and views per listing.' },
  analytics: { name: 'Leads and analytics', description: '' },
  export: { name: 'Leads and analytics', description: '' },
}

function withTags<T extends { paths: Record<string, Record<string, any>> }>(spec: T) {
  const used: string[] = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    const tag = TAGS[path.split('/')[1]]?.name ?? 'Other'
    if (!used.includes(tag)) used.push(tag)
    for (const o of Object.values(methods)) o.tags = [tag]
  }
  const tags = used.map(name => ({ name, description: Object.values(TAGS).find(t => t.name === name && t.description)?.description ?? '' }))
  return { ...spec, tags, 'x-tagGroups': [{ name: 'Reference', tags: used }] }
}

const extParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } })
const tourIdParam = { name: 'id', in: 'path', required: true, description: "Viewora's tour id (uuid)", schema: { type: 'string', format: 'uuid' } }
const pageParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
]

function corePaths() {
  const agent = { type: 'object', properties: { agent: ref('Agent') } }
  const tour = { type: 'object', properties: { tour: ref('Tour') } }
  return {
    '/agents': {
      post: op({ summary: 'Create an agent', scope: 'agents:write',
        description: 'Creates a Viewora account for the agent. Calling it again with the same external_id returns the existing agent (200, created: false). email is required for live agents and becomes their login; no email is sent. Test agents ignore email.',
        body: ref('AgentInput'),
        responses: { 201: { description: 'Created', content: json({ type: 'object', properties: { agent: ref('Agent'), created: { type: 'boolean' } } }) }, 200: { description: 'Already existed' }, 400: errorResponse('VALIDATION_ERROR'), 403: errorResponse('AGENT_LIMIT_REACHED'), 409: errorResponse('EMAIL_IN_USE'), 502: errorResponse('ACCOUNT_CREATE_FAILED') } }),
      get: op({ summary: 'List your agents', scope: 'agents:write', parameters: pageParams,
        responses: { 200: { description: 'A page', content: json({ type: 'object', properties: { agents: { type: 'array', items: ref('Agent') }, limit: { type: 'integer', example: 50 }, offset: { type: 'integer', example: 0 } } }) } } }),
    },
    '/agents/{external_id}': {
      get: op({ summary: 'Read one agent', scope: 'agents:write', parameters: [extParam('external_id', 'Your id for the agent')],
        responses: { 200: { description: 'The agent', content: json(agent) }, 404: errorResponse('AGENT_NOT_FOUND') } }),
    },
    '/tours': {
      post: op({ summary: 'Create a tour', scope: 'listings:write',
        description: `type is one of ${SPACE_TYPES.join(', ')}. details may hold: ${FACT_KEYS.join(', ')}. A repeated external_id answers 409 TOUR_EXISTS with the existing tour in error.tour.`,
        body: ref('TourInput'),
        responses: { 201: { description: 'Created (draft)', content: json(tour) }, 400: errorResponse('VALIDATION_ERROR'), 403: errorResponse('TOUR_LIMIT_REACHED'), 404: errorResponse('AGENT_NOT_FOUND'), 409: errorResponse('TOUR_EXISTS') } }),
      get: op({ summary: 'List or find tours', scope: 'listings:read',
        parameters: [{ name: 'external_id', in: 'query', description: 'Find the tour for one of your listing ids', schema: { type: 'string' } }, { name: 'agent_external_id', in: 'query', schema: { type: 'string' } }, ...pageParams],
        responses: { 200: { description: 'A page', content: json({ type: 'object', properties: { tours: { type: 'array', items: ref('Tour') }, limit: { type: 'integer', example: 50 }, offset: { type: 'integer', example: 0 } } }) } } }),
    },
    '/tours/{id}': {
      get: op({ summary: 'Read one tour', scope: 'listings:read', parameters: [tourIdParam], responses: { 200: { description: 'The tour', content: json(tour) }, 404: errorResponse('TOUR_NOT_FOUND') } }),
      delete: op({ summary: 'Delete a tour', scope: 'listings:write', description: 'Permanent. The tour, its scenes and its page are removed.', parameters: [tourIdParam], responses: { 204: { description: 'Deleted' }, 404: errorResponse('TOUR_NOT_FOUND') } }),
    },
    '/tours/{id}/publish': { post: op({ summary: 'Publish a tour', scope: 'listings:write', description: 'After this the tour has embed_url and share_url.', parameters: [tourIdParam], responses: { 200: { description: 'Published', content: json(tour) }, 404: errorResponse('TOUR_NOT_FOUND') } }) },
    '/tours/{id}/unpublish': { post: op({ summary: 'Take a tour down', scope: 'listings:write', parameters: [tourIdParam], responses: { 200: { description: 'Now a draft', content: json(tour) }, 404: errorResponse('TOUR_NOT_FOUND') } }) },
    '/tours/{id}/uploads': { post: op({ summary: 'Start an upload', scope: 'media:write',
      description: 'Step 1 of 3. Returns a signed URL valid for 15 minutes. Step 2: PUT the file to upload_url with the headers given. Step 3: POST /tours/{id}/uploads/complete. kind: panorama (a 2:1 360° JPEG, becomes a scene), photo (goes to the gallery) or car_exterior (one angle of a car spin).',
      parameters: [tourIdParam], body: ref('UploadStart'),
      responses: { 201: { description: 'Upload URL', content: json({ type: 'object', properties: { upload_key: { type: 'string' }, upload_url: { type: 'string' }, method: { const: 'PUT' }, headers: { type: 'object' }, expires_in: { type: 'integer', example: 900 } } }) }, 413: errorResponse('FILE_TOO_LARGE'), 429: errorResponse('DAILY_UPLOAD_CAP') } }) },
    '/tours/{id}/uploads/complete': { post: op({ summary: 'Finish an upload', scope: 'media:write',
      description: 'Step 3 of 3. Processing starts and takes a short while. Calling this twice for the same file is safe. car_exterior needs angle (0 = front).',
      parameters: [tourIdParam], body: ref('UploadComplete'),
      responses: { 200: { description: 'Processing', content: json({ type: 'object', properties: { upload: { type: 'object', properties: { upload_key: { type: 'string' }, kind: { type: 'string' }, status: { const: 'processing' } } } } }) }, 400: errorResponse('INVALID_UPLOAD_KEY'), 403: errorResponse('SCENE_LIMIT_REACHED') } }) },
  }
}

export function buildOpenApi(opts: { listings?: boolean } = {}) {
  const listings = opts.listings ?? true
  const listing = { type: 'object', properties: { listing: ref('Listing'), applied: { type: 'boolean' }, changed: { type: 'boolean' } } }
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Viewora Partner API',
      version: '1.0.0',
      description: guideMarkdown(listings),
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
        Agent: { type: 'object', properties: { external_id: { type: 'string', example: 'agent-118' }, name: { type: 'string', example: 'Wanjiku Motors' }, created_at: { type: 'string', format: 'date-time', example: '2026-11-24T08:00:00Z' } } },
        AgentInput: schemaOf(createAgentBody),
        Tour: { type: 'object', properties: {
          id: { type: 'string', format: 'uuid', example: '3f6c2a9e-8b1d-4c5e-9f7a-2d4b6e8a0c11' }, external_id: { type: 'string', example: 'CAR-123' }, agent_external_id: { type: ['string', 'null'], example: 'agent-118' }, mode: { enum: ['test', 'live'], example: 'test' },
          title: { type: 'string', example: 'Toyota Prado TX 2019' }, type: { enum: [...SPACE_TYPES], example: 'automotive' }, status: { enum: ['draft', 'published'], example: 'published' }, has_360: { type: 'boolean', example: true }, has_photos: { type: 'boolean', example: true },
          cover_image_url: { type: ['string', 'null'] }, embed_url: { type: ['string', 'null'], example: 'https://app.viewora.software/embed/toyota-prado-tx-2019' }, share_url: { type: ['string', 'null'], example: 'https://app.viewora.software/p/toyota-prado-tx-2019' },
          created_at: { type: 'string', format: 'date-time', example: '2026-11-24T08:00:00Z' }, updated_at: { type: 'string', format: 'date-time', example: '2026-11-24T08:05:00Z' },
        } },
        TourInput: schemaOf(createTourBody),
        UploadStart: schemaOf(createUploadBody),
        UploadComplete: schemaOf(completeUploadBody),
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
    paths: { ...corePaths(), ...(listings ? {
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
    } : {}) } as Record<string, Record<string, any>>,
    ...(listings ? { webhooks: { event: { post: {
      summary: 'Event sent to your endpoint',
      description: 'POSTed to the URL you registered, with a Viewora-Signature header. Answer any 2xx within 10 seconds.',
      requestBody: { content: json(ref('WebhookEvent')) },
      responses: { 200: { description: 'Any 2xx acknowledges the event' } },
    } } } } : {}),
  }
  return withTags(spec)
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
