import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Webhook signing and secret storage. Viewora must sign with the secret, so
// it is stored encrypted (AES-256-GCM, key in PARTNER_WEBHOOK_KEY), not hashed.

export const EVENT_TYPES = [
  'listing.created', 'listing.updated', 'listing.published', 'listing.unpublished',
  'listing.moderation_held', 'listing.rejected', 'listing.archived', 'listing.restored',
  'listing.expired', 'media.failed', 'import.completed',
  'claim.approved', 'claim.declined', 'claim.expired',
] as const
export type EventType = typeof EVENT_TYPES[number] | 'webhook.test'

/** Endpoints per partner per mode. */
export const MAX_WEBHOOKS = 5
/** 8 attempts over about 24 hours: the first, then these waits. */
export const RETRY_DELAYS_S = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600]
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1
/** An endpoint failing without a break for this long is switched off. */
export const DISABLE_AFTER_MS = 3 * 86400_000
/** Partners should refuse signatures older than this. */
export const SIGNATURE_TOLERANCE_S = 300
/** After a rotation the old secret keeps signing this long, so the partner can switch without missing events. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generateWebhookSecret(): string {
  let s = ''
  while (s.length < 32) {
    for (const b of randomBytes(48)) if (b < 248 && s.length < 32) s += ALPHABET[b % 62]
  }
  return `whsec_${s}`
}

/** Reads PARTNER_WEBHOOK_KEY: 32 bytes as 64 hex characters or base64. Null when unset or malformed. */
export function webhookKey(env = process.env.PARTNER_WEBHOOK_KEY): Buffer | null {
  if (!env) return null
  const raw = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64')
  return raw.length === 32 ? raw : null
}

export function encryptSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.')
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [iv, tag, ct] = stored.split('.').map(p => Buffer.from(p, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/**
 * Viewora-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">.
 * During a secret rotation there is one v1 per valid secret (new first).
 */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000), alsoSignWith: string[] = []): string {
  const sig = (s: string) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex')
  return [`t=${t}`, ...[secret, ...alsoSignWith].map(s => `v1=${sig(s)}`)].join(',')
}

/** What a partner runs on their side (also used in the docs and tests). Any matching v1 passes. */
export function verifySignature(secret: string, body: string, header: string, now = Math.floor(Date.now() / 1000)): boolean {
  const pairs = header.split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const })
  const t = Number(pairs.find(([k]) => k === 't')?.[1])
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_TOLERANCE_S || !sigs.length) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'))
  return sigs.some(v => { const got = Buffer.from(v); return got.length === expected.length && timingSafeEqual(got, expected) })
}

export function subscribed(events: readonly string[], type: string): boolean {
  return type === 'webhook.test' ? false : events.includes('*') || events.includes(type)
}

/** Wait before attempt number `attempts + 1`, with ±10% jitter so retries don't arrive together. */
export function nextAttemptDelayMs(attemptsSoFar: number, rand = Math.random): number | null {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null
  const base = RETRY_DELAYS_S[Math.max(0, attemptsSoFar - 1)] * 1000
  return Math.round(base * (0.9 + rand() * 0.2))
}

export function eventBody(ev: { id: string; event_type: string; created_at: string; mode: string; payload: unknown }): string {
  return JSON.stringify({ id: `evt_${ev.id}`, type: ev.event_type, created_at: ev.created_at, mode: ev.mode, data: ev.payload })
}
