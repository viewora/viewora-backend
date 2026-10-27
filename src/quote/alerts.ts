// New-lead email to staff. The lead is already saved before this runs, so a
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
  const base = { leadId: lead.leadId, channel: 'staff_alert' as const, templateKey: TEMPLATE_NEW_LEAD }

  const template = await store.messageTemplate(TEMPLATE_NEW_LEAD, 'email')
  if (!template) {
    log.error({ leadId: lead.leadId }, 'quote: new-lead alert template missing (run migration 003)')
    await store.recordMessage({ ...base, templateVersion: null, renderedBody: null, status: 'failed', error: 'template_missing' })
    return 'failed'
  }

  const vars = {
    name: lead.firstName,
    industry: lead.industry,
    client_type: lead.clientType,
    source: lead.source ?? 'direct',
    admin_link: `${config.adminUrl}/dashboard/quotes/${lead.leadId}`,
  }
  const subject = render(template.subject ?? '', vars)
  const text = render(template.body, vars)
  const message = { ...base, templateVersion: template.version, renderedBody: text }

  const to = [...new Set([...config.extraRecipients, ...await store.alertRecipients()].map(e => e.toLowerCase()))]
  if (!to.length) {
    log.warn({ leadId: lead.leadId }, 'quote: new-lead alert has no recipients (set QUOTE_ALERT_EMAILS or staff alert_new_leads)')
    await store.recordMessage({ ...message, status: 'skipped', skipReason: 'no_recipients' })
    return 'skipped'
  }
  if (!config.liveSend) {
    log.info({ leadId: lead.leadId, recipients: to.length }, 'quote: new-lead alert not sent (sandbox; set QUOTE_ALERTS_SEND=1)')
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
  log.error({ leadId: lead.leadId, error: lastError }, 'quote: new-lead alert failed after retries')
  await store.recordMessage({ ...message, status: 'failed', error: lastError.slice(0, 500) })
  return 'failed'
}
