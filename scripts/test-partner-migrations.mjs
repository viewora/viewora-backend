// Applies partner-api migrations 001-003 to a real Postgres (PGlite, Postgres
// compiled to WebAssembly: no Docker, no server), exercises every constraint
// and trigger of 003, then runs the rollback and applies 003 again.
//
// PGlite is not a project dependency. Run from any scratch folder:
//   npm init -y && npm install @electric-sql/pglite@0.2.17
//   cp <repo>/scripts/test-partner-migrations.mjs . && node test-partner-migrations.mjs <repo>/src/utils
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const dir = process.argv[2]
const sql = f => readFileSync(`${dir}/${f}`, 'utf8')
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
async function refuses(name, q, re) {
  try { await db.query(q); ok(name, false, '(was accepted)') }
  catch (e) { ok(name, re ? re.test(e.message) : true, re && !re.test(e.message) ? e.message : '') }
}

// Supabase stand-ins: roles, auth.users, the tours table.
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
`)
for (const f of ['migration-partner-api-001.sql', 'migration-partner-api-002.sql', 'migration-partner-api-003.sql']) {
  try { await db.exec(sql(f)); ok(`applies ${f}`, true) } catch (e) { ok(`applies ${f}`, false, e.message); process.exit(1) }
}

const one = async (q, p) => (await db.query(q, p)).rows[0]
const p1 = await one(`INSERT INTO api_partners (name, slug) VALUES ('Acme Homes', 'acme-homes') RETURNING id`)
const p2 = await one(`INSERT INTO api_partners (name, slug) VALUES ('Other Co', 'other-co') RETURNING id`)
const u = await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)
const ag = await one(`INSERT INTO api_partner_agents (partner_id, mode, external_id, user_id) VALUES ($1, 'live', 'agent-118', $2) RETURNING id`, [p1.id, u.id])
const sp = await one(`INSERT INTO properties DEFAULT VALUES RETURNING id`)
const tr = await one(`INSERT INTO api_partner_tours (partner_id, mode, external_id, space_id, agent_id) VALUES ($1, 'live', 'HSE-0042', $2, $3) RETURNING id`, [p1.id, sp.id, ag.id])

// The trigger takes partner and mode from the tour ref, whatever was sent.
const st = await one(`INSERT INTO api_listing_state (tour_ref_id, partner_id, mode, vertical, transaction, price_amount, price_currency, price_period, deposit_amount)
  VALUES ($1, $2, 'test', 'property', 'rent', 85000, 'KES', 'month', 170000) RETURNING partner_id, mode, version, publication_status, availability, location_display_precision`, [tr.id, p2.id])
ok('partner_id and mode come from the tour ref, not the caller', st.partner_id === p1.id && st.mode === 'live', JSON.stringify(st))
ok('defaults: version 1, draft, available, approx pin', st.version === 1 && st.publication_status === 'draft' && st.availability === 'available' && st.location_display_precision === 'approx_500m')

await refuses('a second state row for the same listing', `INSERT INTO api_listing_state (tour_ref_id, partner_id, mode, vertical, transaction) VALUES ('${tr.id}', '${p1.id}', 'live', 'property', 'rent')`, /duplicate key/)
await refuses('state row for a tour ref that does not exist', `INSERT INTO api_listing_state (tour_ref_id, partner_id, mode, vertical, transaction) VALUES (gen_random_uuid(), '${p1.id}', 'live', 'property', 'rent')`)
await refuses('price without currency', `UPDATE api_listing_state SET deposit_amount = NULL, price_currency = NULL`, /api_listing_state_price_currency/)
await refuses('deposit with no currency', `UPDATE api_listing_state SET price_amount = NULL, price_currency = NULL`, /price_currency|extras_currency/)
await refuses('negative price', `UPDATE api_listing_state SET price_amount = -1`, /check/i)
await refuses('unknown availability', `UPDATE api_listing_state SET availability = 'gone'`, /check/i)
await refuses('lat without lng', `UPDATE api_listing_state SET location_lat = -1.29`, /latlng/)
await refuses('archived without archived_at', `UPDATE api_listing_state SET publication_status = 'archived'`, /archive/)
await refuses('archived_at while still published', `UPDATE api_listing_state SET archived_at = now()`, /archive/)
await refuses('vin_hash that is not a SHA-256', `UPDATE api_listing_state SET vin_hash = 'JTEBH3FJ10K123456'`, /check/i)
await refuses('details that is not an object', `UPDATE api_listing_state SET details = '[]'`, /check/i)
await db.query(`UPDATE api_listing_state SET publication_status = 'archived', archived_at = now(), restore_until = now() + interval '30 days'`)
ok('archive with archived_at is accepted', true)
const beforeUpd = await one(`SELECT updated_at FROM api_listing_state`)
await db.query(`SELECT pg_sleep(0.01)`)
await db.query(`UPDATE api_listing_state SET availability = 'rented'`)
const afterUpd = await one(`SELECT updated_at, partner_id FROM api_listing_state`)
ok('updated_at is stamped on update', afterUpd.updated_at > beforeUpd.updated_at)

// Audit log: append-only, old rows may be purged.
await db.query(`INSERT INTO api_audit_log (partner_id, mode, actor_type, actor_id, action, entity_type, entity_id, changes)
  VALUES ($1, 'live', 'partner_key', 'key-1', 'listing.updated', 'listing', 'HSE-0042', '{"availability":["available","rented"]}')`, [p1.id])
ok('audit insert works', true)
await refuses('audit update is refused', `UPDATE api_audit_log SET action = 'listing.deleted'`, /append-only/)
await refuses('audit delete of a recent row is refused', `DELETE FROM api_audit_log`, /append-only/)
await refuses('audit truncate is refused', `TRUNCATE api_audit_log`, /append-only/)
await refuses('audit action must look like entity.verb', `INSERT INTO api_audit_log (actor_type, action, entity_type) VALUES ('system', 'Updated!', 'listing')`, /check/i)
await db.query(`INSERT INTO api_audit_log (actor_type, action, entity_type, occurred_at) VALUES ('system', 'listing.expired', 'listing', now() - interval '25 months')`)
const purged = await db.query(`DELETE FROM api_audit_log WHERE occurred_at < now() - interval '24 months'`)
ok('audit rows older than 24 months can be purged', purged.affectedRows === 1)

// Idempotency keys
const h = 'a'.repeat(64)
await db.query(`INSERT INTO api_idempotency_keys (partner_id, mode, idem_key, method, path, request_hash) VALUES ($1, 'live', 'k1', 'POST', '/v1/listings', $2)`, [p1.id, h])
await refuses('same idempotency key twice', `INSERT INTO api_idempotency_keys (partner_id, mode, idem_key, method, path, request_hash) VALUES ('${p1.id}', 'live', 'k1', 'POST', '/v1/listings', '${h}')`, /duplicate key/)
await db.query(`INSERT INTO api_idempotency_keys (partner_id, mode, idem_key, method, path, request_hash) VALUES ($1, 'live', 'k1', 'POST', '/v1/listings', $2)`, [p2.id, h])
ok('the same key is fine for another partner', true)
const exp = await one(`SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM api_idempotency_keys LIMIT 1`)
ok('idempotency keys expire after 24 hours', exp.s === 86400, String(exp.s))

// Lockdown
const rls = await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('api_listing_state','api_audit_log','api_idempotency_keys')`)
ok('RLS on for all three tables', rls.rows.length === 3 && rls.rows.every(r => r.relrowsecurity))
const pol = await one(`SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname LIKE 'api_%'`)
ok('no policies on api_ tables', pol.n === 0)

// Deleting the tour ref removes its state; deleting a partner keeps its audit trail.
await db.query(`INSERT INTO api_audit_log (partner_id, actor_type, action, entity_type) VALUES ($1, 'staff', 'partner.deleted', 'partner')`, [p1.id])
await db.query(`DELETE FROM api_partners WHERE id = $1`, [p1.id])
ok('partner delete cascades to listing state', (await one(`SELECT count(*)::int AS n FROM api_listing_state`)).n === 0)
ok('partner delete keeps the audit trail', (await one(`SELECT count(*)::int AS n FROM api_audit_log WHERE partner_id = $1`, [p1.id])).n === 2)

// Rollback, then apply again.
await db.exec(sql('migration-partner-api-003.down.sql'))
const left = await one(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('api_listing_state','api_audit_log','api_idempotency_keys')`)
const fns = await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'api_%'`)
ok('rollback removes the tables and functions', left.n === 0 && fns.n === 0)
ok('rollback keeps migrations 001 and 002', (await one(`SELECT count(*)::int AS n FROM api_partners`)).n === 1)
await db.exec(sql('migration-partner-api-003.sql'))
ok('migration 003 applies again after rollback', true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
