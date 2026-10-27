// Staff emails (new lead, deposit paid). The lead is already saved before this runs, so a
// failure here never loses an answer: it is retried, then recorded as failed
// on the lead (qe_messages) and logged at error level.
//
// Sandbox by default: unless QUOTE_ALERTS_SEND=1 nothing is sent, and the
// lead's message log shows what would have gone out.

import type { QuoteStore } from './store.js'

export interface AlertConfig {
  liveSend: boolean
  extraRecipients: string[]            // QUOTE_ALERT_EMAILS, on top of opted-in staff
  adminUrl: string                     // QUOTE_ADMIN_URL, e.g. https://admin.viewora.software
  send: (msg: { to: string[]; subject: string; text: string }) => Promise<unknown>
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

export interface AlertLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export const TEMPLATE_NEW_LEAD = 'staff_new_lead'

// {{name}} placeholders; anything unknown renders empty rather than leaking braces
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '')
}

export function alertConfigFromEnv(send: AlertConfig['send']): AlertConfig {
  return {
    liveSend: process.env.QUOTE_ALERTS_SEND === '1',
    extraRecipients: (process.env.QUOTE_ALERT_EMAILS ?? '').split(',').map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+$/.test(s)),
    adminUrl: (process.env.QUOTE_ADMIN_URL ?? '').replace(/\/$/, ''),
    send,
  }
}

export async function alertNewLead(
  store: QuoteStore,
  config: AlertConfig,
  log: AlertLog,
  lead: { leadId: string; firstName: string; industry: string; clientType: string; source: string | null },
): Promise<'sent' | 'skipped' | 'failed'> {
  return alertStaff(store, config, log, {
    leadId: lead.leadId, templateKey: TEMPLATE_NEW_LEAD, what: 'new-lead alert', migration: '003',
    vars: {
      name: lead.firstName,
      industry: lead.industry,
      client_type: lead.clientType,
      source: lead.source ?? 'direct',
      admin_link: `${config.adminUrl}/dashboard/quotes/${lead.leadId}`,
    },
  })
}

// Any staff email from an editable template: sandboxed, retried, and
// recorded on the lead whatever happens
export async function alertStaff(
  store: QuoteStore,
  config: AlertConfig,
  log: AlertLog,
  alert: { leadId: string; quoteId?: string | null; templateKey: string; what: string; migration: string; vars: Record<string, string> },
): Promise<'sent' | 'skipped' | 'failed'> {
  const { leadId, what } = alert
  const base = { leadId, quoteId: alert.quoteId ?? null, channel: 'staff_alert' as const, templateKey: alert.templateKey }

  const template = await store.messageTemplate(alert.templateKey, 'email')
  if (!template) {
    log.error({ leadId }, `quote: ${what} template missing (run migration ${alert.migration})`)
    await store.recordMessage({ ...base, templateVersion: null, renderedBody: null, status: 'failed', error: 'template_missing' })
    return 'failed'
  }

  const subject = render(template.subject ?? '', alert.vars)
  const text = render(template.body, alert.vars)
  const message = { ...base, templateVersion: template.version, renderedBody: text }

  const to = [...new Set([...config.extraRecipients, ...await store.alertRecipients()].map(e => e.toLowerCase()))]
  if (!to.length) {
    log.warn({ leadId }, `quote: ${what} has no recipients (set QUOTE_ALERT_EMAILS or staff alert_new_leads)`)
    await store.recordMessage({ ...message, status: 'skipped', skipReason: 'no_recipients' })
    return 'skipped'
  }
  if (!config.liveSend) {
    log.info({ leadId, recipients: to.length }, `quote: ${what} not sent (sandbox; set QUOTE_ALERTS_SEND=1)`)
    await store.recordMessage({ ...message, status: 'skipped', skipReason: 'sandbox' })
    return 'skipped'
  }

  const delays = config.retryDelaysMs ?? [1000, 5000, 20000]
  const sleep = config.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let lastError = ''
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await config.send({ to, subject, text })
      await store.recordMessage({ ...message, status: 'sent', sentAt: new Date().toISOString() })
      return 'sent'
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt < delays.length) await sleep(delays[attempt])
    }
  }
  log.error({ leadId, error: lastError }, `quote: ${what} failed after retries`)
  await store.recordMessage({ ...message, status: 'failed', error: lastError.slice(0, 500) })
  return 'failed'
}
