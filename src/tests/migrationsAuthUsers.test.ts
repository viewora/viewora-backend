import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The backend's service role cannot read auth.users on our Supabase project:
// a function that selects from it fails at run time with "permission denied
// for table users" (quote engine 011 fixed three). Read emails and names
// from public.profiles instead. A foreign key (REFERENCES auth.users) is fine.

const dir = join(import.meta.dirname, '..', 'utils')
// Old migrations whose auth.users reads a later migration replaced
const superseded: Record<string, string> = {
  'migration-quote-engine-003.sql': 'qe_alert_recipients, replaced in 011',
  'migration-quote-engine-004.sql': 'qe_desk_staff and qe_desk_staff_list, replaced in 011',
}

test('no migration reads auth.users (use profiles)', () => {
  const offenders: string[] = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))) {
    if (superseded[file]) continue
    const sql = readFileSync(join(dir, file), 'utf8')
      .replace(/--.*$/gm, '')               // comments may mention it
      .replace(/\/\*[\s\S]*?\*\//g, '')
    sql.split('\n').forEach((line, i) => {
      if (/\b(from|join)\s+auth\.users\b/i.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'Read from public.profiles instead of auth.users:\n' + offenders.join('\n'))
})
