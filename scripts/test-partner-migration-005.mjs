// Applies partner-api migrations 001-005 to PGlite (Postgres in WebAssembly),
// checks 005, rolls it back and applies it again. Same setup as the 004 test:
//   npm install @electric-sql/pglite@0.2.17 in a scratch folder, then
//   node test-partner-migration-005.mjs <repo>/src/utils
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const dir = process.argv[2]
const sql = f => readFileSync(`${dir}/${f}`, 'utf8')
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
async function refuses(name, q, params, re) {
  try { await db.query(q, params); ok(name, false, '(was accepted)') }
  catch (e) { ok(name, re ? re.test(e.message) : true, re && !re.test(e.message) ? e.message : '') }
}
const one = async (q, p) => (await db.query(q, p)).rows[0]

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, is_published boolean DEFAULT false, title text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid);
`)
for (const n of ['001', '002', '003', '004', '005']) {
  try { await db.exec(sql(`migration-partner-api-${n}.sql`)); ok(`applies ${n}`, true) } catch (e) { ok(`applies ${n}`, false, e.message); process.exit(1) }
}

const p1 = await one(`INSERT INTO api_partners (name, slug) VALUES ('Acme Homes', 'acme-homes') RETURNING id`)
const p2 = await one(`INSERT INTO api_partners (name, slug) VALUES ('Other', 'other-co') RETURNING id`)
const u1 = await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)
const u2 = await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)
const a1 = await one(`INSERT INTO api_partner_agents (partner_id, mode, external_id, user_id) VALUES ($1, 'live', 'ag-1', $2) RETURNING id`, [p1.id, u1.id])
await one(`INSERT INTO api_partner_agents (partner_id, mode, external_id, user_id) VALUES ($1, 'live', 'ag-x', $2) RETURNING id`, [p2.id, u2.id])

// Texts
ok('starting wording is seeded and active', (await one(`SELECT count(*)::int n FROM api_texts WHERE active`)).n === 2)
await refuses('two active versions of one text are refused', `INSERT INTO api_texts (key, locale, version, body) VALUES ('lead_share_consent', 'en', 2, 'x')`, [], /duplicate/)
await db.query(`UPDATE api_texts SET active = false WHERE key = 'lead_share_consent'`)
await db.query(`INSERT INTO api_texts (key, locale, version, body) VALUES ('lead_share_consent', 'en', 2, 'Share with {partner}')`)
ok('a new version can replace the old one', (await one(`SELECT version FROM api_texts WHERE key = 'lead_share_consent' AND active`)).version === 2)
await refuses('a bad key is refused', `INSERT INTO api_texts (key, body) VALUES ('Bad Key!', 'x')`, [], /check/i)

// Consents
const sp = await one(`INSERT INTO properties (user_id, is_published) VALUES ($1, true) RETURNING id`, [u1.id])
const lead = await one(`INSERT INTO leads (property_id) VALUES ($1) RETURNING id`, [sp.id])
await db.query(`INSERT INTO api_lead_consents (lead_id, partner_id, mode, wording, accepted) VALUES ($1, $2, 'live', 'Share with Acme Homes', true)`, [lead.id, p1.id])
await refuses('one consent row per lead', `INSERT INTO api_lead_consents (lead_id, partner_id, mode, wording, accepted) VALUES ($1, $2, 'live', 'x', false)`, [lead.id, p1.id], /duplicate/)
await db.query(`DELETE FROM leads WHERE id = $1`, [lead.id])
ok('deleting a lead deletes its consent', (await one(`SELECT count(*)::int n FROM api_lead_consents`)).n === 0)

// Claims
await db.query(`INSERT INTO api_listing_claims (partner_id, mode, agent_id, space_id, external_id) VALUES ($1, 'live', $2, $3, 'HSE-1')`, [p1.id, a1.id, sp.id])
ok('a claim starts pending with a 14-day expiry', (await one(`SELECT status, expires_at > now() + interval '13 days' AS later FROM api_listing_claims`)).later === true)
await refuses('a second open claim on the same tour', `INSERT INTO api_listing_claims (partner_id, mode, agent_id, space_id, external_id) VALUES ($1, 'live', $2, $3, 'HSE-2')`, [p1.id, a1.id, sp.id], /duplicate/)
await db.query(`UPDATE api_listing_claims SET status = 'declined'`)
await db.query(`INSERT INTO api_listing_claims (partner_id, mode, agent_id, space_id, external_id) VALUES ($1, 'live', $2, $3, 'HSE-1')`, [p1.id, a1.id, sp.id])
ok('after a decline a new claim can be made', (await one(`SELECT count(*)::int n FROM api_listing_claims`)).n === 2)
await refuses('an unknown claim status', `UPDATE api_listing_claims SET status = 'maybe'`, [], /check/i)

// Rotation columns
ok('webhooks have rotation columns', (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'api_webhooks' AND column_name IN ('prev_secret_cipher', 'prev_secret_expires_at')`)).n === 2)

// Export
const s2 = await one(`INSERT INTO properties (user_id, is_published, updated_at) VALUES ($1, true, now() - interval '1 hour') RETURNING id`, [u1.id])
await one(`INSERT INTO properties (user_id, is_published) VALUES ($1, false) RETURNING id`, [u1.id])
await one(`INSERT INTO properties (user_id, is_published) VALUES ($1, true) RETURNING id`, [u2.id])
const page1 = (await db.query(`SELECT id, updated_at FROM api_export_spaces($1, 'live', NULL, NULL, 1)`, [p1.id])).rows
ok('export: newest published tour of this partner first', page1.length === 1 && page1[0].id === sp.id)
const page2 = (await db.query(`SELECT id FROM api_export_spaces($1, 'live', $2, $3, 10)`, [p1.id, page1[0].updated_at, page1[0].id])).rows
ok('export: the cursor continues; drafts and other partners never appear', page2.length === 1 && page2[0].id === s2.id, JSON.stringify(page2))
ok('export: test mode sees nothing', (await db.query(`SELECT id FROM api_export_spaces($1, 'test', NULL, NULL, 10)`, [p1.id])).rows.length === 0)
const grants = await one(`SELECT has_function_privilege('anon', 'api_export_spaces(uuid,text,timestamptz,uuid,integer)', 'execute') AS anon`)
ok('anon cannot run the export function', grants.anon === false)
for (const t of ['api_texts', 'api_lead_consents', 'api_listing_claims']) {
  ok(`RLS on ${t}`, (await one(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [t])).relrowsecurity === true)
}

// Rollback and re-apply
try { await db.exec(sql('migration-partner-api-005.down.sql')); ok('rollback runs', true) } catch (e) { ok('rollback runs', false, e.message) }
ok('rollback removes the tables', (await one(`SELECT count(*)::int n FROM pg_class WHERE relname IN ('api_texts', 'api_lead_consents', 'api_listing_claims')`)).n === 0)
ok('rollback keeps 004', (await one(`SELECT count(*)::int n FROM pg_class WHERE relname = 'api_webhooks'`)).n === 1)
try { await db.exec(sql('migration-partner-api-005.sql')); ok('applies again after rollback', true) } catch (e) { ok('applies again after rollback', false, e.message) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
