// ┌──────────────────────────────────────────────────────────────────────┐
// │ KRA eTIMS INVOICING HOOK                                             │
// │                                                                      │
// │ Every successful payment (deposit or balance, Paystack or recorded   │
// │ by hand) gets a qe_invoices row with status 'pending', and then      │
// │ issueInvoice() below runs. It does not talk to KRA yet: it marks the │
// │ row 'not_configured' so staff can see which payments still need an   │
// │ invoice issued by hand.                                              │
// │                                                                      │
// │ To connect eTIMS: once the accountant has picked the integration     │
// │ (a KRA-approved VSCU/OSCU provider or the eTIMS API), implement      │
// │ EtimsProvider, set QUOTE_ETIMS_PROVIDER, and return it from          │
// │ etimsProvider(). Store the KRA invoice number as externalRef. Money  │
// │ is whole KES; check with the accountant how VAT is shown before      │
// │ sending anything.                                                    │
// └──────────────────────────────────────────────────────────────────────┘

import type { JobRecord, PaymentRecord } from './jobs.js'
import type { JobStore } from './jobStore.js'

export interface EtimsProvider {
  name: string
  issue(input: { job: JobRecord; payment: PaymentRecord }): Promise<{ externalRef: string }>
}

// No provider is connected yet (see the box above)
export function etimsProvider(): EtimsProvider | null {
  return null
}

export async function issueInvoice(
  jobs: JobStore,
  log: { info(o: object, m: string): void; error(o: object, m: string): void },
  input: { invoiceId: string; jobId: string; paymentId: string },
  provider: EtimsProvider | null = etimsProvider(),
): Promise<'issued' | 'failed' | 'not_configured'> {
  if (!provider) {
    await jobs.updateInvoice(input.invoiceId, { status: 'not_configured' })
    log.info({ jobId: input.jobId }, 'quote: eTIMS not connected; invoice left for staff to issue')
    return 'not_configured'
  }
  try {
    const job = await jobs.job(input.jobId)
    const payment = job?.payments?.find(p => p.id === input.paymentId)
    if (!job || !payment) throw new Error('job or payment missing')
    const { externalRef } = await provider.issue({ job, payment })
    await jobs.updateInvoice(input.invoiceId, { status: 'issued', provider: provider.name, externalRef })
    return 'issued'
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.error({ jobId: input.jobId, error }, 'quote: eTIMS invoice failed')
    await jobs.updateInvoice(input.invoiceId, { status: 'failed', provider: provider.name, error: error.slice(0, 500) })
    return 'failed'
  }
}
