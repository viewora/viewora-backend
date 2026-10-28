// Entry links and partner commission (Phase 4b).
//
// Two kinds of /q/:code link:
//   * dm: made for one named person in a DM. The code is random and only its
//     SHA-256 is stored, like quote links, so staff copy it once when it is
//     made. It prefills the first name and expires.
//   * campaign: printed on a QR code or put on an industry page. No personal
//     data, so the code is stored as typed (people read it off posters).
// A partner is credited with ?p=CODE on any form link, or by a link that
// carries their code. The first partner to bring a lead keeps it.
//
// Commission is owed once the job's balance is paid, on the job's price
// after discount and before VAT (hosting is billed separately, so it is
// never in the job price). Cancelled or refunded jobs owe nothing.

import crypto from 'node:crypto'
import { z } from 'zod'

export type LinkKind = 'dm' | 'campaign'

export interface LinkPrefill {
  firstName?: string
  moduleKey?: string
  industryHint?: string
  town?: string
  source?: string
  partnerCode?: string
}

export interface EntryLink {
  id: string
  kind: LinkKind
  code: string | null              // campaign links only; a DM code is never stored
  label: string | null
  prefill: LinkPrefill
  leadId: string | null
  leadName: string | null
  createdBy: string | null
  createdByName: string | null
  uses: number
  maxUses: number | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

export const DM_LINK_DAYS = Number(process.env.QUOTE_DM_LINK_DAYS ?? 30)

// 12 random bytes: 16 characters, short enough for a DM, too many to guess
export const newDmCode = () => crypto.randomBytes(12).toString('base64url')
export const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex')

// What a visitor may type or a link may carry: letters, digits, - and _
export const codeSchema = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/)
// A campaign code staff choose: lower case so posters and typing agree
export const campaignCodeSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'Use 3 to 40 lower-case letters, digits or dashes.')
export const partnerCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2 to 20 letters, digits or dashes.')

// The key a link is stored under
export const storedKey = (kind: LinkKind, code: string) => (kind === 'dm' ? hashCode(code) : code.toLowerCase())

export type LinkState = 'active' | 'expired' | 'revoked' | 'used_up'

export function linkState(link: Pick<EntryLink, 'expiresAt' | 'revokedAt' | 'uses' | 'maxUses'>, now: Date): LinkState {
  if (link.revokedAt) return 'revoked'
  if (link.expiresAt && Date.parse(link.expiresAt) <= now.getTime()) return 'expired'
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'used_up'
  return 'active'
}

// ── Partners and commission ──────────────────────────────────────────────

export interface Partner {
  id: string
  name: string
  code: string
  commissionType: 'percent' | 'fixed'
  commissionValue: number          // basis points for percent, whole KES for fixed
  active: boolean
  createdAt: string
  leads: number
}

// One job brought by a partner, as the report needs it
export interface CommissionJob {
  jobId: string
  jobRef: string
  leadId: string
  leadName: string | null
  partnerId: string
  partnerName: string
  partnerCode: string
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  currency: 'KES' | 'USD'
  net: number                      // price after discount, before VAT
  status: string
  depositStatus: 'pending' | 'paid' | 'refunded'
  balanceStatus: 'pending' | 'paid' | 'waived'
  balancePaidAt: string | null
  payout: { id: string; amount: number; reference: string | null; paidAt: string; paidByName: string | null } | null
}

export type CommissionStatus = 'owed' | 'paid' | 'waiting' | 'none'

export interface CommissionRow extends CommissionJob {
  commission: number | null        // null when it has to be agreed by hand
  commissionStatus: CommissionStatus
  reason: string | null
}

export function commissionFor(job: CommissionJob): CommissionRow {
  const row = (commission: number | null, commissionStatus: CommissionStatus, reason: string | null): CommissionRow =>
    ({ ...job, commission, commissionStatus, reason })
  if (job.payout) return row(job.payout.amount, 'paid', null)
  if (job.status === 'cancelled') return row(0, 'none', 'Job cancelled')
  if (job.depositStatus === 'refunded') return row(0, 'none', 'Deposit refunded')
  // A waived balance is not full payment
  if (job.balanceStatus !== 'paid') return row(amount(job), 'waiting', job.balanceStatus === 'waived' ? 'Balance waived' : 'Balance not paid yet')
  return row(amount(job), amount(job) === null ? 'waiting' : 'owed', amount(job) === null ? 'Fixed fee is in KES; agree this USD job by hand' : null)
}

function amount(job: CommissionJob): number | null {
  if (job.commissionType === 'percent') return Math.round(job.net * job.commissionValue / 10_000)
  return job.currency === 'KES' ? job.commissionValue : null
}

export function commissionCsv(rows: CommissionRow[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    // Quote anything with a comma, quote or newline; a leading = + - @ could run as a formula
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['Partner', 'Partner code', 'Job', 'Client', 'Currency', 'Price before VAT', 'Rate', 'Commission', 'Status', 'Balance paid', 'Paid out', 'Payout reference']
  const rate = (r: CommissionRow) => (r.commissionType === 'percent' ? `${r.commissionValue / 100}%` : `KES ${r.commissionValue} per job`)
  const lines = rows.map(r => [
    r.partnerName, r.partnerCode, r.jobRef, r.leadName, r.currency, r.net, rate(r), r.commission,
    r.commissionStatus, r.balancePaidAt?.slice(0, 10), r.payout?.paidAt.slice(0, 10), r.payout?.reference,
  ].map(cell).join(','))
  return [head.join(','), ...lines].join('\n') + '\n'
}
