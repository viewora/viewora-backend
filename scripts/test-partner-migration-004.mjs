// Applies partner-api migrations 001-004 to a real Postgres (PGlite, in
// WebAssembly: no Docker), exercises 004's tables and api_listing_commit(),
// then rolls 004 back and applies it again.
//
// PGlite is not a project dependency. Run from any scratch folder:
//   npm init -y && npm install @electric-sql/pglite@0.2.17
//   cp <repo>/scripts/test-partner-migration-004.mjs . && node test-partner-migration-004.mjs <repo>/src/utils
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const dir = process.argv[2]
const sql = f => readFileSync(`${dir}/${f}`, 'utf8')
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
async function refuses(name, q, params, re) {
  try { await db.query(q, params); ok(name, false, '(was accepted)') }
  catch (e) { ok(name, re ? re.test(e.message) || re.test(e.code ?? '') : true, re && !(re.test(e.message) || re.test(e.code ?? '')) ? `${e.code} ${e.message}` : '') }
}

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
`)
for (const f of ['001', '002', '003', '004'].map(n => `migration-partner-api-${n}.sql`)) {
  try { await db.exec(sql(f)); ok(`applies ${f}`, true) } catch (e) { ok(`applies ${f}`, false, e.message); process.exit(1) }
}

const one = async (q, p) => (await db.query(q, p)).rows[0]
const p1 = await one(`INSERT INTO api_partners (name, slug) VALUES ('Acme Homes', 'acme-homes') RETURNING id`)
const u = await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)
const ag = await one(`INSERT INTO api_partner_agents (partner_id, mode, external_id, user_id) VALUES ($1, 'live', 'agent-118', $2) RETURNING id`, [p1.id, u.id])
const sp = await one(`INSERT INTO properties DEFAULT VALUES RETURNING id`)
const tr = await one(`INSERT INTO api_partner_tours (partner_id, mode, external_id, space_id, agent_id) VALUES ($1, 'live', 'HSE-0042', $2, $3) RETURNING id`, [p1.id, sp.id, ag.id])

// Keys: scopes and expiry
await db.query(`INSERT INTO api_partner_keys (partner_id, mode, key_prefix, key_hash) VALUES ($1, 'live', 'vo_live_abcd', 'h1')`, [p1.id])
ok('an existing-style key (no scopes) still inserts', (await one(`SELECT scopes FROM api_partner_keys`)).scopes === null)
await db.query(`UPDATE api_partner_keys SET scopes = ARRAY['listings:read','listings:write'], expires_at = now() + interval '12 months'`)
ok('known scopes are accepted', true)
await refuses('an unknown scope is refused', `UPDATE api_partner_keys SET scopes = ARRAY['admin:all']`, [], /check/i)

// api_listing_commit: insert
const commit = (version, state, audit, events) => one(`SELECT api_listing_commit($1, $2, $3, $4, $5) AS r`,
  [tr.id, version, JSON.stringify(state), audit ? JSON.stringify(audit) : null, JSON.stringify(events ?? [])])
const audit = action => ({ actor_type: 'partner_key', actor_id: 'k-1', action, changes: { title: [null, 'x'] }, request_id: 'req-1' })
const created = (await commit(null, { vertical: 'property', transaction: 'rent', price_amount: 85000, price_currency: 'KES', price_period: 'month', listing: { title: 'Flat' } },
  audit('listing.created'), [{ event_type: 'listing.created', payload: { id: 'x' } }])).r
ok('insert returns version 1', created.version === 1, JSON.stringify(created))
const row = await one(`SELECT * FROM api_listing_state WHERE tour_ref_id = $1`, [tr.id])
ok('insert applies column defaults', row.publication_status === 'draft' && row.availability === 'available' &&
  Array.isArray(row.moderation_reasons) && row.price_negotiable === false && row.location_display_precision === 'approx_500m' && row.change_origin === 'api')
ok('insert stamps partner and mode from the tour ref', row.partner_id === p1.id && row.mode === 'live')
ok('insert writes the audit row in the same call', (await one(`SELECT count(*)::int AS n FROM api_audit_log WHERE action = 'listing.created' AND entity_id = $1`, [tr.id])).n === 1)
ok('insert writes the outbox event with partner and mode', (await one(`SELECT count(*)::int AS n FROM api_outbox WHERE event_type = 'listing.created' AND partner_id = $1 AND mode = 'live'`, [p1.id])).n === 1)
await refuses('a second insert for the same listing', `SELECT api_listing_commit($1, NULL, '{"vertical":"property","transaction":"rent"}', NULL, '[]')`, [tr.id], /duplicate key|23505/)

// update
const upd = (await commit(1, { availability: 'reserved' }, audit('listing.updated'), [{ event_type: 'listing.updated', payload: {} }])).r
ok('update with the right version returns version 2', upd.version === 2)
const row2 = await one(`SELECT availability, price_amount, listing FROM api_listing_state WHERE tour_ref_id = $1`, [tr.id])
ok('update changes only the keys sent', row2.availability === 'reserved' && Number(row2.price_amount) === 85000 && row2.listing.title === 'Flat')
await refuses('update with an old version is a conflict (VO409)', `SELECT api_listing_commit($1, 1, '{"availability":"sold"}', NULL, '[]')`, [tr.id], /VO409|version conflict/)
ok('a refused update writes no audit row and no event',
  (await one(`SELECT count(*)::int AS n FROM api_outbox`)).n === 2 && (await one(`SELECT count(*)::int AS n FROM api_audit_log`)).n === 2)
await refuses('update of a missing listing (VO404)', `SELECT api_listing_commit(gen_random_uuid(), 1, '{}', NULL, '[]')`, [], /VO404|not found/)
await commit(2, { partner_id: u.id, mode: 'test', version: 99 }, null, [])
const row3 = await one(`SELECT partner_id, mode, version FROM api_listing_state WHERE tour_ref_id = $1`, [tr.id])
ok('partner_id, mode and version in p_state are ignored', row3.partner_id === p1.id && row3.mode === 'live' && row3.version === 3, JSON.stringify(row3))
await refuses('a bad value still hits the table checks', `SELECT api_listing_commit($1, 3, '{"price_amount":-5}', NULL, '[]')`, [tr.id], /check/i)
await refuses('an audit action must look like entity.verb', `SELECT api_listing_commit($1, 3, '{}', '{"actor_type":"system","action":"Bad"}', '[]')`, [tr.id], /check/i)
ok('the failed call rolled back (still version 3)', (await one(`SELECT version FROM api_listing_state`)).version === 3)
await commit(3, { pending_listing: { price: { amount: 1 } }, publication_status: 'pending_moderation' }, null, [])
ok('pending_listing is stored', (await one(`SELECT pending_listing FROM api_listing_state`)).pending_listing.price.amount === 1)

// Media, webhooks, deliveries, imports
await db.query(`INSERT INTO api_listing_media (tour_ref_id, partner_id, mode, kind, source_url) VALUES ($1, $2, 'live', 'photo', 'https://x.co.ke/1.jpg')`, [tr.id, p1.id])
await refuses('the same media URL twice for one listing', `INSERT INTO api_listing_media (tour_ref_id, partner_id, mode, kind, source_url) VALUES ($1, $2, 'live', 'photo', 'https://x.co.ke/1.jpg')`, [tr.id, p1.id], /duplicate key/)
await refuses('media over plain http', `INSERT INTO api_listing_media (tour_ref_id, partner_id, mode, kind, source_url) VALUES ($1, $2, 'live', 'photo', 'http://x.co.ke/2.jpg')`, [tr.id, p1.id], /check/i)
const wh = await one(`INSERT INTO api_webhooks (partner_id, mode, url, events, secret_cipher, secret_prefix) VALUES ($1, 'live', 'https://crm.example.co.ke/hooks', ARRAY['listing.updated'], 'c', 'whsec_ab') RETURNING id`, [p1.id])
await refuses('webhook over plain http', `INSERT INTO api_webhooks (partner_id, mode, url, events, secret_cipher, secret_prefix) VALUES ($1, 'live', 'http://crm.example.co.ke', ARRAY['x.y'], 'c', 'p')`, [p1.id], /check/i)
await refuses('webhook with no events', `INSERT INTO api_webhooks (partner_id, mode, url, events, secret_cipher, secret_prefix) VALUES ($1, 'live', 'https://a.co.ke', ARRAY[]::text[], 'c', 'p')`, [p1.id], /check/i)
const ev = await one(`SELECT id FROM api_outbox ORDER BY seq LIMIT 1`)
await db.query(`INSERT INTO api_webhook_deliveries (webhook_id, event_id, partner_id) VALUES ($1, $2, $3)`, [wh.id, ev.id, p1.id])
await refuses('one delivery per event per endpoint', `INSERT INTO api_webhook_deliveries (webhook_id, event_id, partner_id) VALUES ($1, $2, $3)`, [wh.id, ev.id, p1.id], /duplicate key/)
await db.query(`INSERT INTO api_imports (partner_id, mode, total, items) VALUES ($1, 'live', 2, '[{},{}]')`, [p1.id])
await refuses('an import over 500 items', `INSERT INTO api_imports (partner_id, mode, total) VALUES ($1, 'live', 501)`, [p1.id], /check/i)
ok('import counts start at zero', (await one(`SELECT counts FROM api_imports`)).counts.created === 0)

// Lockdown
const names = ['api_listing_media', 'api_outbox', 'api_webhooks', 'api_webhook_deliveries', 'api_imports']
const rls = await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [names])
ok('RLS on for all five new tables', rls.rows.length === 5 && rls.rows.every(r => r.relrowsecurity))
ok('no policies on api_ tables', (await one(`SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname LIKE 'api_%'`)).n === 0)
const grant = await one(`SELECT has_function_privilege('anon', 'api_listing_commit(uuid,integer,jsonb,jsonb,jsonb)', 'EXECUTE') AS a,
  has_function_privilege('authenticated', 'api_listing_commit(uuid,integer,jsonb,jsonb,jsonb)', 'EXECUTE') AS b`)
ok('anon and authenticated cannot call api_listing_commit', !grant.a && !grant.b)

// Deleting the tour ref removes its media and state; events stay until the partner goes.
await db.query(`DELETE FROM api_partner_tours WHERE id = $1`, [tr.id])
ok('tour ref delete cascades to state and media',
  (await one(`SELECT count(*)::int AS n FROM api_listing_state`)).n === 0 && (await one(`SELECT count(*)::int AS n FROM api_listing_media`)).n === 0)

// Rollback 004, then apply again; then roll back 004 and 003 in order.
await db.exec(sql('migration-partner-api-004.down.sql'))
const left = await one(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1)`, [names])
const cols = await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name = 'api_partner_keys' AND column_name IN ('scopes','expires_at'))
  OR (table_name = 'api_listing_state' AND column_name IN ('listing','pending_listing','reviewed_at','reviewed_by'))`)
const fn = await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'api_listing_commit'`)
ok('rollback removes the tables, columns and function', left.n === 0 && cols.n === 0 && fn.n === 0)
ok('rollback keeps the keys', (await one(`SELECT count(*)::int AS n FROM api_partner_keys`)).n === 1)
await db.exec(sql('migration-partner-api-004.sql'))
ok('migration 004 applies again after rollback', true)
await db.exec(sql('migration-partner-api-004.down.sql'))
await db.exec(sql('migration-partner-api-003.down.sql'))
ok('004 then 003 roll back cleanly', true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
