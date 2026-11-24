import { lookup as dnsLookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'

// Outbound HTTPS to partner-supplied URLs (media source_url, webhook
// endpoints). Only https, only public IP addresses, a size cap and a timeout.
// The address check runs inside the socket's DNS lookup, so a hostname that
// re-resolves to a private address between "check" and "connect" (DNS
// rebinding) is still refused.

export class SafeFetchError extends Error {
  constructor(public code: 'URL_NOT_HTTPS' | 'URL_PRIVATE_NETWORK' | 'TIMEOUT' | 'TOO_LARGE' | 'NETWORK' | 'BAD_URL', message: string) {
    super(message)
  }
}

/** True for loopback, private, link-local, CGNAT, metadata, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||           // CGNAT
      (a === 169 && b === 254) ||                     // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||                       // 192.0.0.0/24, 192.0.2.0/24
      (a === 198 && (b === 18 || b === 19)) ||        // benchmarking
      (a === 198 && b === 51) || (a === 203 && b === 0)
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === '::' || s === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8')
  }
  return true
}

export function checkUrlShape(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new SafeFetchError('BAD_URL', 'Not a valid URL') }
  if (u.protocol !== 'https:') throw new SafeFetchError('URL_NOT_HTTPS', 'Use an https:// URL')
  if (u.username || u.password) throw new SafeFetchError('BAD_URL', 'URLs with a username or password are not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SafeFetchError('URL_PRIVATE_NETWORK', 'This URL points to a private network')
  }
  if (isIP(host) && isPrivateAddress(host)) throw new SafeFetchError('URL_PRIVATE_NETWORK', 'This URL points to a private network')
  return u
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: any) => {
    if (err) return callback(err, '' as any, 0)
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }]) as { address: string; family: number }[]
    if (!list.length || list.some(a => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('private address'), { code: 'URL_PRIVATE_NETWORK' }) as any, '' as any, 0)
    }
    if ((options as any)?.all) return (callback as any)(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

/** Resolves the host now and refuses private addresses (used when a webhook URL is registered). */
export async function assertPublicHost(raw: string): Promise<void> {
  const u = checkUrlShape(raw)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return
  await new Promise<void>((resolve, reject) => {
    safeLookup(host, {}, (err: any) => {
      if (!err) return resolve()
      reject(err.code === 'URL_PRIVATE_NETWORK'
        ? new SafeFetchError('URL_PRIVATE_NETWORK', 'This URL points to a private network')
        : new SafeFetchError('NETWORK', 'The host name could not be found'))
    })
  })
}

export type SafeResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

export type SafeFetchOptions = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  maxBytes?: number
}

export type SafeFetch = (url: string, opts?: SafeFetchOptions) => Promise<SafeResponse>

/** Follows no redirects: a redirect could point anywhere. */
export const safeFetch: SafeFetch = (raw, opts = {}) => new Promise((resolve, reject) => {
  let u: URL
  try { u = checkUrlShape(raw) } catch (e) { return reject(e) }
  const maxBytes = opts.maxBytes ?? 1_000_000
  const timeoutMs = opts.timeoutMs ?? 10_000
  const req = httpsRequest(u, {
    method: opts.method ?? 'GET',
    headers: { 'user-agent': 'Viewora-Partner-Fetch/1', ...(opts.headers ?? {}) },
    lookup: safeLookup,
    timeout: timeoutMs,
  }, res => {
    const declared = Number(res.headers['content-length'] ?? 0)
    if (declared > maxBytes) {
      res.destroy()
      return reject(new SafeFetchError('TOO_LARGE', `The file is larger than ${Math.round(maxBytes / 1048576)} MB`))
    }
    const chunks: Buffer[] = []
    let size = 0
    res.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        res.destroy()
        reject(new SafeFetchError('TOO_LARGE', `The file is larger than ${Math.round(maxBytes / 1048576)} MB`))
        return
      }
      chunks.push(c)
    })
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    res.on('error', () => reject(new SafeFetchError('NETWORK', 'The connection failed')))
  })
  const deadline = setTimeout(() => req.destroy(new SafeFetchError('TIMEOUT', `No answer within ${timeoutMs / 1000} seconds`)), timeoutMs)
  req.on('timeout', () => req.destroy(new SafeFetchError('TIMEOUT', `No answer within ${timeoutMs / 1000} seconds`)))
  req.on('error', (e: any) => {
    clearTimeout(deadline)
    if (e instanceof SafeFetchError) return reject(e)
    if (e?.code === 'URL_PRIVATE_NETWORK') return reject(new SafeFetchError('URL_PRIVATE_NETWORK', 'This URL points to a private network'))
    reject(new SafeFetchError('NETWORK', 'The connection failed'))
  })
  req.on('close', () => clearTimeout(deadline))
  if (opts.body) req.write(opts.body)
  req.end()
})
