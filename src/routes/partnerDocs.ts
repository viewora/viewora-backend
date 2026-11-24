import type { FastifyInstance } from 'fastify'
import { buildOpenApi, buildPostman } from '../partners/openapi.js'

// Developer docs for the Partner API at /docs: a written guide plus the full
// endpoint reference, drawn by Scalar (MIT licence, https://github.com/scalar/scalar)
// from the same OpenAPI description the API is validated against.
// Off unless PARTNER_DOCS_ENABLED=1.
//
// Privacy: Scalar's telemetry, AI agent and MCP features are switched off, and
// the page's CSP only lets it talk to this server, so a key typed into
// "Try it" can never leave for a third party.

// Pinned build, loaded from jsDelivr with a Subresource Integrity hash: if the
// file ever changes, the browser refuses to run it. To upgrade, change both.
export const SCALAR_VERSION = '1.76.4'
export const SCALAR_SRC = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`
export const SCALAR_SRI = 'sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q'

export const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Viewora's neutral palette (Viewora/assets/css/main.css --vo-* tokens): black
// accent on off-white, no gradients.
const CSS = `
:root { --scalar-font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --scalar-font-code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --scalar-radius: 6px; --scalar-radius-lg: 10px; }
.light-mode { --scalar-background-1: #ffffff; --scalar-background-2: #f8f8f7; --scalar-background-3: #f1f1f0;
  --scalar-color-1: #111111; --scalar-color-2: #5f5f5c; --scalar-color-3: #8c8c87; --scalar-color-accent: #111111;
  --scalar-background-accent: #f1f1f0; --scalar-border-color: #dededb; }
.dark-mode { --scalar-background-1: #0d0d0d; --scalar-background-2: #070707; --scalar-background-3: #141414;
  --scalar-color-1: #f4f4f1; --scalar-color-2: #a0a09a; --scalar-color-3: #70706b; --scalar-color-accent: #f4f4f1;
  --scalar-background-accent: #141414; --scalar-border-color: #242424; }
.markdown table { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewora Partner API</title>
<meta name="description" content="Put 360° tours on your property and car listings: guide and API reference for Viewora partners.">
<meta name="robots" content="index, follow">
</head>
<body>
<noscript><p style="font-family:system-ui;padding:16px">This page needs JavaScript. The same reference is at <a href="/docs/openapi.json">/docs/openapi.json</a>.</p></noscript>
<div id="app"></div>
<script src="${SCALAR_SRC}" integrity="${SCALAR_SRI}" crossorigin="anonymous"></script>
<script src="/docs/init.js"></script>
</body>
</html>
`

// Same-origin config script (no inline JS, so the CSP can stay strict). The
// "Try it" server is this host, so requests never go through a proxy.
const INIT = `Scalar.createApiReference('#app', {
  customCss: ${JSON.stringify(CSS)},
  url: '/docs/openapi.json',
  servers: [{ url: location.origin + '/v1', description: 'Viewora' }],
  authentication: { preferredSecurityScheme: 'partnerKey' },
  defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
  metaData: { title: 'Viewora Partner API' },
  withDefaultFonts: false,
  telemetry: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  showDeveloperTools: 'never',
  persistAuth: false,
  documentDownloadType: 'json',
});
`

export default async function partnerDocsRoutes(fastify: FastifyInstance, opts: { listings?: boolean } = {}) {
  const listings = opts.listings ?? process.env.PARTNER_LISTINGS_ENABLED === '1'
  const spec = buildOpenApi({ listings })
  const postman = buildPostman(spec)
  const limit = { rateLimit: { max: 120, timeWindow: '1 minute' } }
  const cache = 'public, max-age=300'

  fastify.get('/docs', { config: limit }, async (_req, reply) => reply
    .header('Content-Security-Policy', DOCS_CSP)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'strict-origin-when-cross-origin')
    .header('Cache-Control', cache)
    .type('text/html; charset=utf-8')
    .send(PAGE))
  fastify.get('/docs/init.js', { config: limit }, async (_req, reply) => reply.header('Cache-Control', cache).type('application/javascript; charset=utf-8').send(INIT))
  fastify.get('/docs/openapi.json', { config: limit }, async (_req, reply) => reply.header('Cache-Control', cache).header('Access-Control-Allow-Origin', '*').send(spec))
  fastify.get('/docs/postman.json', { config: limit }, async (_req, reply) => reply
    .header('Cache-Control', cache)
    .header('Content-Disposition', 'attachment; filename="viewora-partner-api.postman.json"')
    .send(postman))
}
