import { createHmac, timingSafeEqual } from 'crypto'

// One-click unsubscribe for the app's non-essential emails (nudge, weekly
// digest, monthly report). Gmail and Yahoo require a working
// List-Unsubscribe + List-Unsubscribe-Post header on promotional mail sent at
// volume (RFC 8058); without it those emails count against domain reputation.
//
// The token is stateless: `<userId>.<hmac>` signed with
// EMAIL_UNSUBSCRIBE_SECRET, so no table of tokens is needed and a link can't
// be forged for someone else's account. If the secret is unset, marketing
// emails go out without the header (logged once) rather than failing.

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? 'https://api.viewora.software').replace(/\/$/, '')

function secret(): string | null {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || null
}

function sign(userId: string, key: string): string {
  return createHmac('sha256', key).update(`unsubscribe:${userId}`).digest('base64url')
}

export function makeUnsubscribeToken(userId: string): string | null {
  const key = secret()
  return key ? `${userId}.${sign(userId, key)}` : null
}

/** Returns the user id the token was issued for, or null if it is invalid. */
export function verifyUnsubscribeToken(token: unknown): string | null {
  const key = secret()
  if (!key || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const userId = token.slice(0, dot)
  const given = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(userId, key))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return userId
}

let warnedMissingSecret = false

/**
 * Headers and footer link for a marketing email to `userId`. Empty when the
 * secret is not configured or the caller has no user id.
 */
export function unsubscribeFor(userId?: string | null): {
  url?: string
  headers?: Record<string, string>
} {
  if (!userId) return {}
  const token = makeUnsubscribeToken(userId)
  if (!token) {
    if (!warnedMissingSecret) {
      console.warn('[email] EMAIL_UNSUBSCRIBE_SECRET not set — marketing emails sent without List-Unsubscribe')
      warnedMissingSecret = true
    }
    return {}
  }
  const url = `${API_PUBLIC_URL}/email/unsubscribe?token=${encodeURIComponent(token)}`
  return {
    url,
    headers: {
      'List-Unsubscribe': `<${url}>, <mailto:support@viewora.software?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}
