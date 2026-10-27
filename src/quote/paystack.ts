// Paystack for quote deposits and balances. This uses its own key
// (QUOTE_PAYSTACK_SECRET_KEY) and its own webhook, separate from the
// subscription billing in routes/billing.ts, which is not touched.
//
// Test mode only until told otherwise: a live key (sk_live_…) is refused
// unless QUOTE_PAYMENTS_LIVE=1 is also set.

import crypto from 'node:crypto'

export interface InitInput {
  email: string
  amount: number                     // Paystack subunits (KES × 100)
  currency: 'KES' | 'USD'
  reference: string
  callbackUrl: string
  channels?: string[]
  metadata?: Record<string, unknown> // ids only, never personal data
}

export interface Verified {
  status: 'success' | 'failed' | 'abandoned' | 'pending'
  amount: number                     // subunits
  currency: string
  channel: string | null
  paidAt: string | null
  gatewayResponse: string | null
  raw: unknown
}

export interface PaystackClient {
  live: boolean
  initialize(input: InitInput): Promise<{ authorizationUrl: string }>
  // null when Paystack has no such transaction
  verify(reference: string): Promise<Verified | null>
}

export class PaystackError extends Error {}

export const paystackLive = (secret: string) => secret.startsWith('sk_live_')

// The x-paystack-signature header is HMAC-SHA512 of the raw body
export function signatureValid(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function httpPaystack(secret: string, fetchImpl: typeof fetch = fetch): PaystackClient {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetchImpl(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const json = await res.json().catch(() => null) as any
    return { ok: res.ok && json?.status === true, status: res.status, json }
  }
  return {
    live: paystackLive(secret),
    async initialize(input) {
      const r = await call('POST', '/transaction/initialize', {
        email: input.email, amount: input.amount, currency: input.currency, reference: input.reference,
        callback_url: input.callbackUrl, channels: input.channels, metadata: input.metadata,
      })
      if (!r.ok || !r.json?.data?.authorization_url) throw new PaystackError(`initialize failed (${r.status}): ${r.json?.message ?? 'no response'}`)
      return { authorizationUrl: r.json.data.authorization_url }
    },
    async verify(reference) {
      const r = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
      if (r.status === 404 || (r.json && r.json.status === false && /not found/i.test(r.json.message ?? ''))) return null
      if (!r.ok) throw new PaystackError(`verify failed (${r.status}): ${r.json?.message ?? 'no response'}`)
      const d = r.json.data
      const status = ['success', 'failed', 'abandoned'].includes(d.status) ? d.status : 'pending'
      return {
        status, amount: Number(d.amount), currency: String(d.currency ?? ''), channel: d.channel ?? null,
        paidAt: d.paid_at ?? d.paidAt ?? null, gatewayResponse: d.gateway_response ?? null,
        // Keep what proves the payment; drop the customer and card details
        raw: { id: d.id, reference: d.reference, status: d.status, amount: d.amount, currency: d.currency, channel: d.channel, paid_at: d.paid_at, gateway_response: d.gateway_response, domain: d.domain },
      }
    },
  }
}

// Reads the key from the environment; null when quote payments are off
export function paystackFromEnv(): PaystackClient | null {
  const secret = process.env.QUOTE_PAYSTACK_SECRET_KEY ?? ''
  if (!secret) return null
  if (paystackLive(secret) && process.env.QUOTE_PAYMENTS_LIVE !== '1') {
    throw new Error('QUOTE_PAYSTACK_SECRET_KEY is a live key. Quote payments run in test mode until QUOTE_PAYMENTS_LIVE=1 is set.')
  }
  return httpPaystack(secret)
}

// ── Fake (tests and the local dev server) ──────────────────────────────────
// Transactions live in memory. `complete` plays the client paying on the
// checkout page; `checkoutBase` is where the fake checkout page is served.

export interface FakePaystack extends PaystackClient {
  transactions: Map<string, InitInput & { status: Verified['status']; channel: string | null; paidAt: string | null; paidAmount?: number }>
  complete(reference: string, opts?: { status?: Verified['status']; channel?: string; amount?: number }): void
  failNextInitialize?: boolean
}

export function fakePaystack(checkoutBase = 'https://checkout.paystack.test'): FakePaystack {
  const transactions: FakePaystack['transactions'] = new Map()
  const fake: FakePaystack = {
    live: false,
    transactions,
    async initialize(input) {
      if (fake.failNextInitialize) { fake.failNextInitialize = false; throw new PaystackError('initialize failed (503): test') }
      transactions.set(input.reference, { ...input, status: 'pending', channel: null, paidAt: null })
      return { authorizationUrl: `${checkoutBase}?reference=${encodeURIComponent(input.reference)}` }
    },
    async verify(reference) {
      const t = transactions.get(reference)
      if (!t) return null
      const amount = t.paidAmount ?? t.amount
      return { status: t.status, amount, currency: t.currency, channel: t.channel, paidAt: t.paidAt, gatewayResponse: t.status === 'success' ? 'Approved' : null, raw: { reference, status: t.status, amount } }
    },
    complete(reference, opts = {}) {
      const t = transactions.get(reference)
      if (!t) throw new Error(`no fake transaction ${reference}`)
      t.status = opts.status ?? 'success'
      t.channel = opts.channel ?? 'mobile_money'
      t.paidAt = t.status === 'success' ? new Date().toISOString() : null
      if (opts.amount !== undefined) t.paidAmount = opts.amount
    },
  }
  return fake
}
