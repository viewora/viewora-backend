// Deposits, bookings and jobs: the rules, with no storage or network.
// The SQL functions in migration-quote-engine-005.sql enforce the same
// money rules again inside the transaction; these decide what to show.

import type { QuoteDoc } from './desk.js'
import { nairobiDate } from './desk.js'
import type { PublicState } from './publicQuote.js'

export type JobStatus = 'booked' | 'scheduled' | 'shot' | 'delivered' | 'closed' | 'cancelled'
export type ShootWindow = 'morning' | 'afternoon'
export type PaymentStatus = 'initialized' | 'success' | 'failed' | 'abandoned'
export type ManualChannel = 'mpesa' | 'cash' | 'bank'

export const JOB_STATUSES = ['booked', 'scheduled', 'shot', 'delivered', 'closed', 'cancelled'] as const satisfies readonly JobStatus[]
export const WINDOWS = ['morning', 'afternoon'] as const satisfies readonly ShootWindow[]

export interface PaymentRecord {
  id: string
  reference: string
  kind: 'deposit' | 'balance'
  provider: 'paystack' | 'manual'
  status: PaymentStatus
  amount: number                 // whole KES (or USD cents), like every price
  currency: 'KES' | 'USD'
  tier: string | null
  channel: string | null
  paidAt: string | null
  failureReason: string | null
  authorizationUrl: string | null
  live: boolean
  quoteId: string
  jobId: string | null
  linkId: string | null
  checks: number
  note: string | null
  recordedByName: string | null
  createdAt: string
}

export interface JobCost { id: string; label: string; amount: number; createdAt: string; createdByName?: string | null }

export interface Hours { travel: number; shoot: number; edit: number; admin: number }

export interface JobRecord {
  id: string
  ref: string
  quoteId: string
  leadId: string
  requestId: string
  quoteVersion: number
  tier: string | null
  status: JobStatus
  price: number
  currency: 'KES' | 'USD'
  depositAmount: number
  depositStatus: 'pending' | 'paid' | 'refunded'
  depositPaidAt: string | null
  balanceAmount: number
  balanceStatus: 'pending' | 'paid' | 'waived'
  balancePaidAt: string | null
  shootDate: string | null                 // YYYY-MM-DD, Nairobi
  shootWindow: ShootWindow | null
  shootDateStatus: 'none' | 'requested' | 'confirmed'
  locationText: string | null
  locationLat: number | null
  locationLng: number | null
  assignedStaffId: string | null
  assignedStaffName: string | null
  hours: Hours
  deliveredAt: string | null
  tourUrl: string | null
  notes: string | null
  industry: string | null
  clientType: string | null
  source: string | null
  leadName: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  costsTotal: number
  costs?: JobCost[]
  payments?: PaymentRecord[]
}

export interface JobPatch {
  status?: JobStatus
  shootDate?: string | null
  shootWindow?: ShootWindow | null
  shootDateStatus?: 'none' | 'requested' | 'confirmed'
  assignedStaffId?: string | null
  hours?: Partial<Hours>
  deliveredAt?: string | null
  tourUrl?: string | null
  notes?: string | null
}

export interface BookingSettings {
  perSlot: number                // shoots per morning or afternoon
  windows: ShootWindow[]
  daysOff: number[]              // 0 = Sunday … 6 = Saturday
  noticeDays: number             // first bookable day is today + this
  horizonDays: number            // how far ahead clients can pick
}

export const DEFAULT_BOOKING: BookingSettings = { perSlot: 1, windows: ['morning', 'afternoon'], daysOff: [0], noticeDays: 2, horizonDays: 45 }

// What a successful settle did. 'already' = this payment was recorded
// before (a repeated webhook); 'duplicate' = money for a job already
// booked or paid, kept on record for a refund; 'mismatch' = Paystack's
// amount or currency differs from ours, so nothing was booked.
export interface SettleResult {
  outcome: 'settled' | 'already' | 'duplicate' | 'mismatch'
  kind: 'deposit' | 'balance'
  paymentId: string
  jobId?: string | null
  quoteId: string
  leadId?: string | null
  invoiceId?: string | null
}

// Why a quote can't take a deposit right now (null = it can)
export type PayBlocker = 'not_open' | 'not_final' | 'no_deposit' | 'already_booked' | 'payments_off'

export function payBlocker(doc: QuoteDoc, state: PublicState, opts: { hasJob: boolean; paymentsOn: boolean }): PayBlocker | null {
  if (!opts.paymentsOn) return 'payments_off'
  if (opts.hasJob || doc.status === 'accepted') return 'already_booked'
  if (state !== 'open') return 'not_open'
  if (doc.mode === 'range' || doc.options.some(o => o.lines.some(l => l.tbc))) return 'not_final'
  if (!doc.options.some(o => o.deposit > 0)) return 'no_deposit'
  return null
}

// Paystack counts KES and USD in their smallest unit
export const toSubunits = (amount: number, currency: 'KES' | 'USD') => (currency === 'KES' ? amount * 100 : amount)

// Day of the week of a YYYY-MM-DD date (read at noon UTC, so no zone drift)
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()

export interface BookingDay { date: string; slots: Array<{ window: ShootWindow; open: boolean }> }

// The days a client may pick, with each slot open or full. `taken` counts
// other jobs per date and window; the client's own job is left out of it.
export function bookingDays(settings: BookingSettings, taken: Array<{ date: string; window: ShootWindow; n: number }>, now: Date): BookingDay[] {
  const used = new Map(taken.map(t => [`${t.date}:${t.window}`, t.n]))
  const days: BookingDay[] = []
  for (let i = settings.noticeDays; i <= settings.horizonDays; i++) {
    const date = nairobiDate(now, i)
    if (settings.daysOff.includes(weekday(date))) continue
    days.push({ date, slots: settings.windows.map(window => ({ window, open: (used.get(`${date}:${window}`) ?? 0) < settings.perSlot })) })
  }
  return days
}

export function slotOpen(days: BookingDay[], date: string, window: ShootWindow): boolean {
  return !!days.find(d => d.date === date)?.slots.find(s => s.window === window)?.open
}

// Hours are kept to the quarter hour
export const totalHours = (h: Hours) => Math.round((h.travel + h.shoot + h.edit + h.admin) * 100) / 100

// Profit is the price less direct costs, as the tracker counts it. Per hour
// is rounded to whole shillings, null until hours are logged.
export function profit(job: Pick<JobRecord, 'price' | 'costsTotal' | 'hours'>) {
  const hours = totalHours(job.hours)
  const value = job.price - job.costsTotal
  return { hours, profit: value, perHour: hours > 0 ? Math.round(value / hours) : null }
}

// ── Tracker CSV ─────────────────────────────────────────────────────────────

export const TRACKER_COLUMNS = [
  'Job', 'Shoot date', 'Client', 'Industry', 'Client type', 'Source', 'Option', 'Status',
  'Price', 'Deposit', 'Balance', 'Balance status',
  'Travel hours', 'Shoot hours', 'Edit hours', 'Admin hours', 'Total hours',
  'Direct costs', 'Profit', 'Profit per hour', 'Currency',
] as const

// Spreadsheet apps run a cell starting with = + - @ as a formula; a client's
// name typed into the form must never do that
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  let s = value
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function trackerCsv(jobs: JobRecord[], labels: { industry: (key: string | null) => string; clientType: (key: string | null) => string }): string {
  const rows = jobs.map(j => {
    const p = profit(j)
    return [
      j.ref, j.shootDate, j.leadName, labels.industry(j.industry), labels.clientType(j.clientType), j.source ?? 'direct', j.tier, j.status,
      j.price, j.depositAmount, j.balanceAmount, j.balanceStatus,
      j.hours.travel, j.hours.shoot, j.hours.edit, j.hours.admin, p.hours,
      j.costsTotal, p.profit, p.perHour, j.currency,
    ].map(csvCell).join(',')
  })
  // BOM so Excel reads the file as UTF-8
  return '﻿' + [TRACKER_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n'
}
