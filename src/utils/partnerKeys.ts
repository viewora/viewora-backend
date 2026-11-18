import { createHash, randomBytes } from 'crypto'

// Partner API keys look like  vo_live_<32 base62 chars>  or  vo_test_<...>.
// Only the SHA-256 hash is stored. The key has ~190 bits of randomness, so a
// plain (unsalted) hash is safe and lets us look a key up by its hash.

export type KeyMode = 'test' | 'live'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SECRET_LEN = 32
const KEY_RE = /^vo_(test|live)_([0-9A-Za-z]{32})$/

export function generatePartnerKey(mode: KeyMode): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(SECRET_LEN * 2)
  let secret = ''
  // Rejection sampling: 248 = 4 * 62, so every character is equally likely.
  for (let i = 0; i < bytes.length && secret.length < SECRET_LEN; i++) {
    if (bytes[i] < 248) secret += ALPHABET[bytes[i] % 62]
  }
  while (secret.length < SECRET_LEN) {
    const b = randomBytes(1)[0]
    if (b < 248) secret += ALPHABET[b % 62]
  }
  const key = `vo_${mode}_${secret}`
  return { key, prefix: key.slice(0, 12), hash: hashPartnerKey(key) }
}

export function hashPartnerKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Reads a Bearer header. Returns null unless it is a well-formed partner key. */
export function parsePartnerKey(authorization: unknown): { key: string; mode: KeyMode } | null {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null
  const key = authorization.slice(7).trim()
  const m = KEY_RE.exec(key)
  return m ? { key, mode: m[1] as KeyMode } : null
}
