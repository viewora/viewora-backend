// Writes the Partner API description and a Postman collection to docs/, and
// turns docs/developers/guide.md into code so the API can serve it at /docs.
//   npm run partner:openapi
// The reference comes from the zod schemas the API validates with
// (src/partners/openapi.ts); the API serves the same description at
// GET /v1/openapi.json and GET /docs/openapi.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const docs = join(root, 'docs')

const guide = readFileSync(join(docs, 'developers', 'guide.md'), 'utf8').replace(/\r\n/g, '\n')
writeFileSync(join(root, 'src', 'partners', 'docsGuide.generated.ts'),
  '// Generated from docs/developers/guide.md by `npm run partner:openapi`. Edit the .md file, not this one.\n' +
  `export const GUIDE_MARKDOWN = ${JSON.stringify(guide)}\n`)

const { buildOpenApi, buildPostman } = await import('../partners/openapi.js')
const spec = buildOpenApi()
writeFileSync(join(docs, 'partner-api.openapi.json'), JSON.stringify(spec, null, 2) + '\n')
writeFileSync(join(docs, 'partner-api.postman.json'), JSON.stringify(buildPostman(spec), null, 2) + '\n')
console.log(`Wrote the guide, docs/partner-api.openapi.json (${Object.keys(spec.paths).length} paths) and docs/partner-api.postman.json`)
