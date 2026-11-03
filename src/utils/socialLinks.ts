// Validation for the social links a space can show in its viewer.
// Mirrors viewora-app/shared/utils/socialLinks.ts (keep the two in step).

export type SocialKey = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'x' | 'linkedin'

interface Network {
  key: SocialKey
  label: string
  /** Hostnames a link must belong to (subdomains allowed). */
  hosts: string[]
  /** What a bare handle ("@name") becomes. */
  fromHandle: (handle: string) => string
  placeholder: string
}

const NETWORKS: Network[] = [
  { key: 'instagram', label: 'Instagram', hosts: ['instagram.com'], fromHandle: h => `https://instagram.com/${h}`, placeholder: '@yourbrand or instagram.com/yourbrand' },
  { key: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'fb.com'], fromHandle: h => `https://facebook.com/${h}`, placeholder: 'Page name or facebook.com/yourpage' },
  { key: 'tiktok', label: 'TikTok', hosts: ['tiktok.com'], fromHandle: h => `https://tiktok.com/@${h}`, placeholder: '@yourbrand or tiktok.com/@yourbrand' },
  { key: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be'], fromHandle: h => `https://youtube.com/@${h}`, placeholder: '@yourchannel or youtube.com/@yourchannel' },
  { key: 'x', label: 'X (Twitter)', hosts: ['x.com', 'twitter.com'], fromHandle: h => `https://x.com/${h}`, placeholder: '@yourbrand or x.com/yourbrand' },
  { key: 'linkedin', label: 'LinkedIn', hosts: ['linkedin.com'], fromHandle: h => `https://linkedin.com/company/${h}`, placeholder: 'Company name or linkedin.com/company/yourco' },
]

export const SOCIAL_KEYS: SocialKey[] = NETWORKS.map(n => n.key)
export const SOCIAL_LABELS: Record<SocialKey, string> = Object.fromEntries(NETWORKS.map(n => [n.key, n.label])) as Record<SocialKey, string>
export const SOCIAL_PLACEHOLDERS: Record<SocialKey, string> = Object.fromEntries(NETWORKS.map(n => [n.key, n.placeholder])) as Record<SocialKey, string>

/**
 * A handle ("@name", "name") or a pasted link → a clean https link on that
 * network's own domain, or null if it isn't one. Anything else (other sites,
 * javascript:, mailto:) is refused, so the viewer only ever links to the
 * networks it shows.
 */
export function normalizeSocialLink(key: SocialKey, input: unknown): string | null {
  const net = NETWORKS.find(n => n.key === key)
  if (!net || typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > 300) return null

  // A link has a scheme, a path, or one of the network's own hostnames; anything else is a handle (which may contain dots).
  const lower = raw.toLowerCase()
  const looksLikeLink = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes('/') || net.hosts.some(h => lower.includes(h))
  if (looksLikeLink) {
    let url: URL
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`) } catch { return null }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    if (!net.hosts.some(h => host === h || host.endsWith(`.${h}`))) return null
    url.protocol = 'https:'
    url.hash = ''
    return url.toString()
  }
  const handle = raw.replace(/^@/, '')
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) return null
  return net.fromHandle(handle)
}

/** Clean a submitted { network: input } map: valid links only; empty / invalid are dropped. */
export function sanitizeSocialLinks(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SOCIAL_KEYS) {
    const href = normalizeSocialLink(key, input[key])
    if (href) out[key] = href
  }
  return out
}
