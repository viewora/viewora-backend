// What a partner key may do. Stored on api_partner_keys.scopes (migration 004).

export const SCOPES = [
  'listings:read', 'listings:write', 'media:write', 'agents:write',
  'webhooks:manage', 'leads:read', 'analytics:read',
] as const
export type Scope = typeof SCOPES[number]

/**
 * Keys issued before scopes existed (scopes NULL) keep the access they had,
 * plus the new listing endpoints, but never leads: lead contact details need
 * a signed data-processing addendum first, so staff grant leads:read by hand.
 */
export const LEGACY_SCOPES: readonly Scope[] = SCOPES.filter(s => s !== 'leads:read')

/** New keys: listings, media and agents (a listing needs an agent), plus webhooks. */
export const DEFAULT_NEW_KEY_SCOPES: readonly Scope[] = [
  'listings:read', 'listings:write', 'media:write', 'agents:write', 'webhooks:manage',
]

/** New keys expire after 12 months unless staff choose otherwise. */
export const KEY_DEFAULT_LIFETIME_DAYS = 365
/** At most two active live keys per partner, so a rotation can overlap. */
export const MAX_ACTIVE_LIVE_KEYS = 2

export function effectiveScopes(stored: readonly string[] | null | undefined): readonly Scope[] {
  if (stored == null) return LEGACY_SCOPES
  return stored.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s))
}

export function hasScope(stored: readonly string[] | null | undefined, needed: Scope): boolean {
  return effectiveScopes(stored).includes(needed)
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return Boolean(expiresAt) && Date.parse(expiresAt as string) <= now
}
