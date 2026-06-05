import { Resend } from 'resend'

const FROM = 'Viewora <hello@viewora.software>'
const APP_URL = 'https://app.viewora.software'
const TIKTOK_URL = 'https://www.tiktok.com/@viewora.software?_r=1&_t=ZS-96X8wZykXbN'
const INSTAGRAM_URL = 'https://www.instagram.com/vieworasoftware/'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

let resend: Resend | null = null
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY)
} else {
  console.warn('[email] RESEND_API_KEY not set — email notifications disabled')
}

export function isEmailEnabled(): boolean {
  return resend !== null
}

// Shared header + footer wrapper used by every email
function emailShell(content: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">

      <div style="background: #0a0a0b; padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
        <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
          <tr>
            <td style="vertical-align: middle; padding-right: 10px;">
              <img src="https://viewora.software/logo-email.png" alt="" width="75" height="60"
                   style="display: block; border-radius: 4px;" />
            </td>
            <td style="vertical-align: middle;">
              <span style="color: #ffffff; font-size: 22px; font-weight: bold; letter-spacing: -0.5px;">Viewora</span>
            </td>
          </tr>
        </table>
      </div>

      <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        ${content}

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

        <p style="color: #9ca3af; font-size: 12px; margin: 0 0 16px 0; text-align: center;">
          Viewora — 360° Virtual Tours for Real Estate and Business.
        </p>

        <div style="text-align: center;">
          <a href="${TIKTOK_URL}" target="_blank"
             style="display: inline-block; margin: 0 4px; text-decoration: none;">
            <img src="https://viewora.software/icon-tiktok.png" alt="TikTok"
                 width="24" height="24" style="display: inline-block;" />
          </a>
          <a href="${INSTAGRAM_URL}" target="_blank"
             style="display: inline-block; margin: 0 4px; text-decoration: none;">
            <img src="https://viewora.software/icon-instagram.png" alt="Instagram"
                 width="24" height="24" style="display: inline-block;" />
          </a>
        </div>
      </div>

    </div>
  `
}

function ctaButton(href: string, text: string, bgColor = '#0a0a0b'): string {
  return `
    <a href="${href}"
       style="display: inline-block; background: ${bgColor}; color: #ffffff; padding: 14px 28px;
              border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;
              margin-bottom: 24px;">
      ${text}
    </a>
  `
}

function greet(name?: string | null): string {
  const first = name ? escapeHtml(name.trim().split(' ')[0]) : null
  return first ? `Hi ${first},` : 'Hello,'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

// ─── HIGH PRIORITY ───────────────────────────────────────────────────────────

// Fired from: billing.ts → invoice.payment_failed webhook
export async function sendPaymentFailedEmail(params: {
  ownerEmail: string
  name?: string | null
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name } = params

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: 'Action required — your Viewora payment failed',
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        We were unable to process your latest Viewora payment. Your subscription is still active for now, but access will be restricted if payment isn't completed soon.
      </p>

      <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: bold;">
          What to do: update your payment method or retry the charge from your billing page.
        </p>
      </div>

      ${ctaButton(`${APP_URL}/app/billing`, 'Update payment method →', '#dc2626')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        If you believe this is a mistake or need help, reply to this email and we'll sort it out.
      </p>
    `),
  })
}

// Fired from: cron/limit-warning — users at ≥80% of their plan's tour or storage quota
export async function sendLimitWarningEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
  toursUsed: number
  toursMax: number
  storageUsedBytes: number
  storageMaxBytes: number
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName, toursUsed, toursMax, storageUsedBytes, storageMaxBytes } = params

  const tourPct = toursMax > 0 ? Math.round((toursUsed / toursMax) * 100) : 0
  const storagePct = storageMaxBytes > 0 ? Math.round((storageUsedBytes / storageMaxBytes) * 100) : 0
  const toursWarning = tourPct >= 80
  const storageWarning = storagePct >= 80
  const safePlan = escapeHtml(planName)

  const warningBlocks = []
  if (toursWarning) {
    warningBlocks.push(`
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
        <p style="margin: 0 0 6px 0; font-weight: bold; color: #92400e; font-size: 14px;">Tours: ${tourPct}% used</p>
        <p style="margin: 0; color: #4b5563; font-size: 14px;">
          ${toursUsed} of ${toursMax} active tours used on your ${safePlan} plan.
        </p>
      </div>
    `)
  }
  if (storageWarning) {
    warningBlocks.push(`
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
        <p style="margin: 0 0 6px 0; font-weight: bold; color: #92400e; font-size: 14px;">Storage: ${storagePct}% used</p>
        <p style="margin: 0; color: #4b5563; font-size: 14px;">
          ${formatBytes(storageUsedBytes)} of ${formatBytes(storageMaxBytes)} used on your ${safePlan} plan.
        </p>
      </div>
    `)
  }

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `You're approaching your ${safePlan} plan limits`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        You're getting close to the limits on your <strong>${safePlan}</strong> plan. Upgrade now to keep creating tours without interruption.
      </p>

      ${warningBlocks.join('')}

      ${ctaButton(`${APP_URL}/app/billing`, 'Upgrade my plan →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions about your plan? Reply to this email.
      </p>
    `),
  })
}

// Fired from: cron/monthly-report — 1st of each month, previous month's performance
export async function sendMonthlyReportEmail(params: {
  ownerEmail: string
  name?: string | null
  monthLabel: string
  totalViews: number
  totalLeads: number
  topTours: Array<{ name: string; views: number; leads: number }>
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, monthLabel, totalViews, totalLeads, topTours } = params

  const tourRows = topTours.slice(0, 5).map(t => `
    <tr>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 14px;">${escapeHtml(t.name)}</td>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 14px; text-align: right;">${t.views.toLocaleString()}</td>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 14px; text-align: right;">${t.leads}</td>
    </tr>
  `).join('')

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your Viewora report for ${monthLabel}`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Here's how your tours performed in <strong>${monthLabel}</strong>.
      </p>

      <table cellpadding="0" cellspacing="0" style="width: 100%; margin: 24px 0;">
        <tr>
          <td style="width: 50%; padding: 20px; background: #f9fafb; border-radius: 8px; text-align: center;">
            <div style="font-size: 36px; font-weight: bold; color: #0a0a0b;">${totalViews.toLocaleString()}</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Total Views</div>
          </td>
          <td style="width: 8px;"></td>
          <td style="width: 50%; padding: 20px; background: #f9fafb; border-radius: 8px; text-align: center;">
            <div style="font-size: 36px; font-weight: bold; color: #0a0a0b;">${totalLeads}</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Total Leads</div>
          </td>
        </tr>
      </table>

      ${topTours.length > 0 ? `
        <p style="font-weight: bold; font-size: 14px; margin-bottom: 0;">Top tours this month:</p>
        <table cellpadding="0" cellspacing="0" style="width: 100%; margin: 0 0 24px 0;">
          <thead>
            <tr>
              <th style="padding: 8px 0; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em;">Tour</th>
              <th style="padding: 8px 0; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em;">Views</th>
              <th style="padding: 8px 0; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em;">Leads</th>
            </tr>
          </thead>
          <tbody>${tourRows}</tbody>
        </table>
      ` : ''}

      ${ctaButton(`${APP_URL}/app/spaces`, 'View full analytics →', '#0066cc')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        This report covers ${monthLabel}. Detailed stats are always available in your dashboard.
      </p>
    `),
  })
}

// Fired from: billing.ts → charge.success webhook, after subscription upsert
export async function sendSubscriptionActivatedEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
  billingCycle: string
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName, billingCycle } = params
  const safePlan = escapeHtml(planName)
  const cycleLabel = billingCycle === 'yearly' ? 'year' : 'month'

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your ${safePlan} plan is now active`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your <strong>${safePlan}</strong> plan is active — billed per ${cycleLabel}.
        You now have full access to all features included in your plan.
      </p>

      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 10px 0; font-weight: bold; color: #15803d; font-size: 14px;">What's included:</p>
        <ul style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 2;">
          <li>Unlimited 360° panorama uploads</li>
          <li>Custom hotspots and branding</li>
          <li>Lead capture on every tour</li>
          <li>Priority support</li>
        </ul>
      </div>

      ${ctaButton(`${APP_URL}/app/create`, 'Create a tour now →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Manage your subscription from your
        <a href="${APP_URL}/app/billing" style="color: #0066cc;">billing page</a>.
      </p>
    `),
  })
}

// Fired from: billing.ts → charge.success webhook, alongside subscription activated
export async function sendPaymentReceiptEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
  billingCycle: string
  amountKES: number
  reference: string
  paidAt: Date
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName, billingCycle, amountKES, reference, paidAt } = params
  const safePlan = escapeHtml(planName)
  const safeRef = escapeHtml(reference)
  const formattedAmount = `KES ${amountKES.toLocaleString('en-KE')}`
  const formattedDate = paidAt.toLocaleDateString('en-KE', { dateStyle: 'long' })
  const cycleLabel = billingCycle === 'yearly' ? 'Annual' : 'Monthly'

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Payment receipt — ${safePlan} ${cycleLabel}`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Thank you — we've received your payment. Here's your receipt.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <table cellpadding="0" cellspacing="0" style="width: 100%;">
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Plan</td>
            <td style="padding: 8px 0; font-weight: bold; font-size: 14px; text-align: right;">
              ${safePlan} (${cycleLabel})
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #e5e7eb;">Amount paid</td>
            <td style="padding: 8px 0; font-weight: bold; font-size: 14px; text-align: right; border-top: 1px solid #e5e7eb;">
              ${formattedAmount}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #e5e7eb;">Date</td>
            <td style="padding: 8px 0; font-size: 14px; text-align: right; border-top: 1px solid #e5e7eb;">
              ${formattedDate}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #e5e7eb;">Reference</td>
            <td style="padding: 8px 0; font-size: 13px; text-align: right; border-top: 1px solid #e5e7eb; color: #9ca3af;">
              ${safeRef}
            </td>
          </tr>
        </table>
      </div>

      ${ctaButton(`${APP_URL}/app/billing`, 'View billing history →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions about this charge? Reply to this email or write to
        <a href="mailto:hello@viewora.software" style="color: #0066cc;">hello@viewora.software</a>.
      </p>
    `),
  })
}

// Fired from: billing.ts → subscription.disable / invoice.payment_failed webhook
export async function sendSubscriptionExpiredEmail(params: {
  ownerEmail: string
  name?: string | null
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name } = params

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: 'Your Viewora subscription has expired',
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your Viewora subscription has expired. Your tours are still live for clients, but you've been moved to free plan limits.
      </p>

      <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 10px 0; font-weight: bold; color: #dc2626; font-size: 14px;">What this means:</p>
        <ul style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 2;">
          <li>New tour creation is paused until you resubscribe</li>
          <li>Published tours remain live for your clients</li>
          <li>Lead capture continues on existing tours</li>
        </ul>
      </div>

      ${ctaButton(`${APP_URL}/app/billing`, 'Resubscribe now →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions? Reply to this email — we're happy to help.
      </p>
    `),
  })
}

// ─── MEDIUM PRIORITY ─────────────────────────────────────────────────────────

// Fired from: cron job — users who signed up 7 days ago with no published tours
export async function sendNoPublishNudgeEmail(params: {
  ownerEmail: string
  name?: string | null
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name } = params

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: 'Your first tour is just a few clicks away',
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        You created your Viewora account a week ago — great first step! We noticed you haven't published your first tour yet.
      </p>
      <p style="color: #4b5563; line-height: 1.6;">
        It takes less than 5 minutes to upload your panoramas and go live. Your clients can start exploring properties from anywhere.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 12px 0; font-weight: bold; font-size: 14px;">Publish your first tour in 3 steps:</p>
        <ol style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 2;">
          <li>Upload one or more 360° panorama photos</li>
          <li>Add hotspots to guide viewers through the space</li>
          <li>Hit publish and share the link with clients</li>
        </ol>
      </div>

      ${ctaButton(`${APP_URL}/app/create`, 'Publish my first tour →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Need help getting started? Reply to this email — we'll walk you through it.
      </p>
    `),
  })
}

// Fired from: cron job — subscriptions expiring in 7 days
export async function sendPlanExpiryReminderEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
  expiresAt: Date
  daysLeft: number
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName, expiresAt, daysLeft } = params
  const safePlan = escapeHtml(planName)
  const formattedDate = expiresAt.toLocaleDateString('en-KE', { dateStyle: 'long' })
  const plural = daysLeft !== 1 ? 's' : ''

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your ${safePlan} plan expires in ${daysLeft} day${plural}`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your <strong>${safePlan}</strong> plan expires on <strong>${formattedDate}</strong> —
        that's ${daysLeft} day${plural} from now.
      </p>
      <p style="color: #4b5563; line-height: 1.6;">
        Renew now to keep all your tours active and continue capturing leads without interruption.
      </p>

      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #92400e; font-size: 14px;">
          After expiry, new tour creation will be paused until you renew.
        </p>
      </div>

      ${ctaButton(`${APP_URL}/app/billing`, 'Renew my plan →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions about your plan? Reply to this email.
      </p>
    `),
  })
}

// ─── LOW PRIORITY ─────────────────────────────────────────────────────────────

// Fired from: cron job — every Monday, aggregates leads from past 7 days per user
export async function sendWeeklyLeadDigestEmail(params: {
  ownerEmail: string
  name?: string | null
  leads: Array<{ leadName: string; leadEmail: string; spaceName: string }>
  periodStart: Date
  periodEnd: Date
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, leads, periodStart, periodEnd } = params
  if (leads.length === 0) return

  const dateRange = `${periodStart.toLocaleDateString('en-KE', { dateStyle: 'medium' })} – ${periodEnd.toLocaleDateString('en-KE', { dateStyle: 'medium' })}`
  const plural = leads.length !== 1 ? 's' : ''

  const leadRows = leads.map(l => `
    <tr>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 14px;">${escapeHtml(l.leadName)}</td>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 14px;">
        <a href="mailto:${escapeHtml(l.leadEmail)}" style="color: #0066cc;">${escapeHtml(l.leadEmail)}</a>
      </td>
      <td style="padding: 10px 0; border-top: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">
        ${escapeHtml(l.spaceName)}
      </td>
    </tr>
  `).join('')

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your weekly digest — ${leads.length} lead${plural} this week`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Here's a summary of the <strong>${leads.length} lead${plural}</strong> you received between ${dateRange}.
      </p>

      <table cellpadding="0" cellspacing="0" style="width: 100%; margin: 24px 0;">
        <thead>
          <tr>
            <th style="padding: 0 0 8px 0; text-align: left; font-size: 12px; color: #9ca3af;
                       text-transform: uppercase; letter-spacing: 0.05em;">Name</th>
            <th style="padding: 0 0 8px 0; text-align: left; font-size: 12px; color: #9ca3af;
                       text-transform: uppercase; letter-spacing: 0.05em;">Email</th>
            <th style="padding: 0 0 8px 0; text-align: left; font-size: 12px; color: #9ca3af;
                       text-transform: uppercase; letter-spacing: 0.05em;">Tour</th>
          </tr>
        </thead>
        <tbody>${leadRows}</tbody>
      </table>

      ${ctaButton(`${APP_URL}/app/spaces`, 'View all leads →', '#0066cc')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        This digest is sent every week. Full contact details are in your dashboard.
      </p>
    `),
  })
}

// ─── EXISTING EMAILS (updated to use shared shell) ───────────────────────────

export async function sendWelcomeEmail(params: {
  ownerEmail: string
  name?: string | null
}): Promise<void> {
  if (!resend) {
    console.warn('[email] sendWelcomeEmail: skipped — RESEND_API_KEY not set')
    return
  }
  const { ownerEmail, name } = params

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: 'Welcome to Viewora — your first tour is one upload away',
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your Viewora account is ready. You can now create interactive 360° virtual tours and share them with clients in minutes.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 12px 0; font-weight: bold; font-size: 14px;">Here's how to get started:</p>
        <ol style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 2;">
          <li>Upload your 360° panorama photos</li>
          <li>Add hotspots to highlight key features</li>
          <li>Publish and share the link with your clients</li>
        </ol>
      </div>

      ${ctaButton(`${APP_URL}/app/create`, 'Create your first tour →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Need help? Reply to this email or visit our
        <a href="https://viewora.software/faq" style="color: #0066cc;">FAQ page</a>.
      </p>
    `),
  })
}

export async function sendLeadNotification(params: {
  ownerEmail: string
  spaceName: string
  spaceSlug: string
  lead: { name: string; email: string; phone?: string | null; message?: string | null }
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, spaceName, spaceSlug, lead } = params
  const safeName = escapeHtml(lead.name)
  const safeEmail = escapeHtml(lead.email)
  const safePhone = lead.phone ? escapeHtml(lead.phone) : null
  const safeMessage = lead.message ? escapeHtml(lead.message) : null
  const safeSpaceName = escapeHtml(spaceName)
  const safeSpaceSlug = escapeHtml(spaceSlug)

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `New lead from your tour: ${safeSpaceName}`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">You have a new lead!</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Someone viewed your tour <strong>${safeSpaceName}</strong> and left their details.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 4px 0; font-size: 14px;"><strong>Name:</strong> ${safeName}</p>
        <p style="margin: 4px 0; font-size: 14px;"><strong>Email:</strong>
          <a href="mailto:${safeEmail}" style="color: #0066cc;">${safeEmail}</a></p>
        ${safePhone ? `<p style="margin: 4px 0; font-size: 14px;"><strong>Phone:</strong> ${safePhone}</p>` : ''}
        ${safeMessage ? `<p style="margin: 4px 0; font-size: 14px;"><strong>Message:</strong> ${safeMessage}</p>` : ''}
      </div>

      ${ctaButton(`${APP_URL}/app/spaces`, 'View all leads →', '#0066cc')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        This lead came from your tour at
        <a href="https://viewora.software/p/${safeSpaceSlug}" style="color: #0066cc;">
          viewora.software/p/${safeSpaceSlug}
        </a>
      </p>
    `),
  })
}

export async function sendCaptureRequestEmail(params: {
  userEmail: string
  userName: string
  serviceName: string
  servicePrice: string
  phone: string
  address: string
  spaceName?: string | null
  preferredDate?: string | null
  notes?: string | null
  planName?: string | null
}): Promise<void> {
  if (!resend) return
  const { userEmail, userName, serviceName, servicePrice, phone, address, spaceName, preferredDate, notes, planName } = params

  const safeName      = escapeHtml(userName)
  const safeService   = escapeHtml(serviceName)
  const safePrice     = escapeHtml(servicePrice)
  const safePhone     = escapeHtml(phone)
  const safeAddress   = escapeHtml(address)
  const safeSpace     = spaceName     ? escapeHtml(spaceName)     : null
  const safeDate      = preferredDate ? escapeHtml(preferredDate) : null
  const safeNotes     = notes         ? escapeHtml(notes)         : null
  const safePlan      = planName      ? escapeHtml(planName)      : 'Free'

  const detailRows = [
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Service</td><td style="padding:8px 0;font-weight:bold;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safeService}</td></tr>`,
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Price</td><td style="padding:8px 0;font-weight:bold;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safePrice}</td></tr>`,
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Address</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safeAddress}</td></tr>`,
    safeSpace ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Property Name</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safeSpace}</td></tr>` : '',
    safeDate  ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Preferred Date</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safeDate}</td></tr>` : '',
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Phone</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safePhone}</td></tr>`,
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">Plan</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #e5e7eb;">${safePlan}</td></tr>`,
  ].join('')

  // Notification to the Viewora ops team
  await resend.emails.send({
    from: FROM,
    to: 'hello@viewora.software',
    subject: `New Capture Booking — ${safeService} (${safePrice})`,
    html: emailShell(`
      <h2 style="font-size:20px;margin-top:0;">New capture booking request</h2>
      <p style="color:#4b5563;line-height:1.6;">
        <strong>${safeName}</strong> (<a href="mailto:${escapeHtml(userEmail)}" style="color:#0066cc;">${escapeHtml(userEmail)}</a>)
        just booked a <strong>${safeService}</strong> shoot.
      </p>
      <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
        <table cellpadding="0" cellspacing="0" style="width:100%;">${detailRows}</table>
      </div>
      ${safeNotes ? `<p style="color:#4b5563;font-size:14px;"><strong>Notes:</strong> ${safeNotes}</p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-bottom:0;">Reply to this email to confirm the booking with the client.</p>
    `),
    replyTo: userEmail,
  })

  // Confirmation to the user
  await resend.emails.send({
    from: FROM,
    to: userEmail,
    subject: `Booking request received — ${safeService}`,
    html: emailShell(`
      <h2 style="font-size:20px;margin-top:0;">${greet(userName)}</h2>
      <p style="color:#4b5563;line-height:1.6;">
        We've received your booking request for a <strong>${safeService}</strong> shoot.
        Our team will contact you within <strong>24 hours</strong> to confirm the details.
      </p>
      <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
        <table cellpadding="0" cellspacing="0" style="width:100%;">${detailRows}</table>
      </div>
      ${safeNotes ? `<p style="color:#4b5563;font-size:14px;"><strong>Your notes:</strong> ${safeNotes}</p>` : ''}
      ${ctaButton(`${APP_URL}/app/capture`, 'View all services →')}
      <p style="color:#6b7280;font-size:13px;margin-bottom:0;">
        Questions? Reply to this email or write to
        <a href="mailto:hello@viewora.software" style="color:#0066cc;">hello@viewora.software</a>.
      </p>
    `),
  })
}

export async function sendTourPublishedEmail(params: {
  ownerEmail: string
  spaceName: string
  spaceSlug: string
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, spaceName, spaceSlug } = params
  const safeSpaceName = escapeHtml(spaceName)
  const safeSpaceSlug = escapeHtml(spaceSlug)
  const tourUrl = `https://viewora.software/p/${safeSpaceSlug}`

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your tour "${safeSpaceName}" is live!`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">Your tour is live!</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your virtual tour <strong>${safeSpaceName}</strong> is now published and ready to share with clients.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 6px 0; font-size: 13px; color: #6b7280;">Your tour link:</p>
        <a href="${tourUrl}" style="color: #0066cc; word-break: break-all; font-size: 15px;">${tourUrl}</a>
      </div>

      ${ctaButton(tourUrl, 'View your tour →')}

      <p style="color: #4b5563; font-size: 14px; margin-bottom: 8px;">
        Share it on WhatsApp to start getting leads:
      </p>

      ${ctaButton(
        `https://wa.me/?text=Check%20out%20this%20virtual%20tour:%20${encodeURIComponent(tourUrl)}`,
        'Share on WhatsApp →',
        '#25D366'
      )}
    `),
  })
}

// ─── GIFT SUBSCRIPTION EMAILS ────────────────────────────────────────────────

/**
 * Sent ~3 days before a gifted plan expires.
 * Fired from: cron/gift-expiry warning phase
 */
export async function sendGiftExpiringSoonEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
  expiresAt: Date
  daysLeft: number
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName, expiresAt, daysLeft } = params
  const safePlan = escapeHtml(planName)
  const formattedDate = expiresAt.toLocaleDateString('en-KE', { dateStyle: 'long' })
  const plural = daysLeft !== 1 ? 's' : ''

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your ${safePlan} plan expires in ${daysLeft} day${plural}`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your complimentary <strong>${safePlan}</strong> plan expires on <strong>${formattedDate}</strong>
        — that's ${daysLeft} day${plural} from now.
      </p>

      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #92400e; font-size: 14px;">
          After expiry, you'll be moved to the Free plan. Your published tours stay live,
          but new uploads and advanced features will be paused.
        </p>
      </div>

      <p style="color: #4b5563; line-height: 1.6;">
        Upgrade now to keep all your features without interruption.
      </p>

      ${ctaButton(`${APP_URL}/app/billing`, 'Upgrade my plan →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions? Reply to this email — we're happy to help.
      </p>
    `),
  })
}

/**
 * Sent when a gifted plan expires and the user is downgraded to Free.
 * Fired from: cron/gift-expiry downgrade phase
 */
export async function sendGiftExpiredEmail(params: {
  ownerEmail: string
  name?: string | null
  planName: string
}): Promise<void> {
  if (!resend) return
  const { ownerEmail, name, planName } = params
  const safePlan = escapeHtml(planName)

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your ${safePlan} plan has ended`,
    html: emailShell(`
      <h2 style="font-size: 20px; margin-top: 0;">${greet(name)}</h2>
      <p style="color: #4b5563; line-height: 1.6;">
        Your complimentary <strong>${safePlan}</strong> plan has ended.
        You've been moved back to the Free plan.
      </p>

      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 10px 0; font-weight: bold; font-size: 14px;">What this means:</p>
        <ul style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 2;">
          <li>Your published tours remain live for clients</li>
          <li>New tour creation is limited to Free plan quota</li>
          <li>Advanced features (embeds, analytics) are paused</li>
        </ul>
      </div>

      <p style="color: #4b5563; line-height: 1.6;">
        Loved the experience? Subscribe now to keep full access.
      </p>

      ${ctaButton(`${APP_URL}/app/billing`, 'Subscribe now →')}

      <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
        Questions? Reply to this email.
      </p>
    `),
  })
}
