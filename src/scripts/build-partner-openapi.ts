// Writes the Partner API description and a Postman collection to docs/.
//   npm run partner:openapi
// Both come from the zod schemas the API validates with (src/partners/openapi.ts),
// and the API serves the same description at GET /v1/openapi.json.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildOpenApi, buildPostman } from '../partners/openapi.js'

const docs = join(import.meta.dirname, '..', '..', 'docs')
const spec = buildOpenApi()
writeFileSync(join(docs, 'partner-api.openapi.json'), JSON.stringify(spec, null, 2) + '\n')
writeFileSync(join(docs, 'partner-api.postman.json'), JSON.stringify(buildPostman(spec), null, 2) + '\n')
console.log(`Wrote docs/partner-api.openapi.json (${Object.keys(spec.paths).length} paths) and docs/partner-api.postman.json`)
