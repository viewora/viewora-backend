import { Resend } from 'resend'

const FROM = 'Viewora <hello@viewora.software>'

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
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">You have a new lead!</h2>
        <p>Someone viewed your tour <strong>${safeSpaceName}</strong> and left their details.</p>

        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Name:</strong> ${safeName}</p>
          <p style="margin: 4px 0;"><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
          ${safePhone ? `<p style="margin: 4px 0;"><strong>Phone:</strong> ${safePhone}</p>` : ''}
          ${safeMessage ? `<p style="margin: 4px 0;"><strong>Message:</strong> ${safeMessage}</p>` : ''}
        </div>

        <a href="https://app.viewora.software/app/spaces"
           style="background: #0066cc; color: white; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; display: inline-block;">
          View all leads
        </a>

        <p style="color: #888; font-size: 12px; margin-top: 32px;">
          This notification was sent because you have an active tour at
          viewora.software/p/${safeSpaceSlug}
        </p>
      </div>
    `,
  })
}

export function isEmailEnabled(): boolean {
  return resend !== null
}

export async function sendWelcomeEmail(params: {
  ownerEmail: string
  name?: string | null
}): Promise<void> {
  if (!resend) {
    console.warn('[email] sendWelcomeEmail: skipped — RESEND_API_KEY not set')
    return
  }
  const { ownerEmail, name } = params
  const firstName = name ? escapeHtml(name.trim().split(' ')[0]) : null
  const greeting = firstName ? `Hi ${firstName},` : 'Welcome to Viewora!'

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: 'Welcome to Viewora — your first tour is one upload away',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
        <div style="background: #0a0a0b; padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
            <tr>
              <td style="vertical-align: middle; padding-right: 10px;">
                <img src="https://viewora.software/logo-email.png" alt="" width="32" height="32"
                     style="display: block; border-radius: 4px;" />
              </td>
              <td style="vertical-align: middle;">
                <span style="color: #ffffff; font-size: 22px; font-weight: bold; letter-spacing: -0.5px;">Viewora</span>
              </td>
            </tr>
          </table>
        </div>

        <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <h2 style="font-size: 20px; margin-top: 0;">${greeting}</h2>
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

          <a href="https://app.viewora.software/app/create"
             style="display: inline-block; background: #0a0a0b; color: #ffffff; padding: 14px 28px;
                    border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px; margin-bottom: 24px;">
            Create your first tour →
          </a>

          <p style="color: #6b7280; font-size: 13px; margin-bottom: 4px;">
            Need help? Reply to this email or visit our
            <a href="https://viewora.software/faq" style="color: #0066cc;">FAQ page</a>.
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

          <p style="color: #9ca3af; font-size: 12px; margin: 0 0 16px 0;">
            You're receiving this because you created a Viewora account.
            <br/>Viewora — 360° Virtual Tours for Real Estate and Business.
          </p>

          <div style="text-align: center;">
            <a href="https://www.tiktok.com/@viewora.software?_r=1&_t=ZS-96X8wZykXbN" target="_blank"
               style="display: inline-block; margin: 0 4px; text-decoration: none;">
              <img src="https://cdn.simpleicons.org/tiktok/ffffff" alt="TikTok"
                   width="24" height="24" style="display: block;" />
            </a>
            <a href="https://www.instagram.com/vieworasoftware/" target="_blank"
               style="display: inline-block; margin: 0 4px; text-decoration: none;">
              <img src="https://cdn.simpleicons.org/instagram/ffffff" alt="Instagram"
                   width="24" height="24" style="display: block;" />
            </a>
          </div>
        </div>
      </div>
    `,
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
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Your tour is live!</h2>
        <p>Your virtual tour <strong>${safeSpaceName}</strong> is now published and ready to share.</p>

        <div style="background: #f0f8ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0; font-size: 14px; color: #555;">Tour link:</p>
          <a href="${tourUrl}" style="color: #0066cc; word-break: break-all;">${tourUrl}</a>
        </div>

        <p>Share this link on WhatsApp, Facebook, or embed it in your listings.</p>

        <a href="https://wa.me/?text=Check%20out%20this%20virtual%20tour:%20${encodeURIComponent(tourUrl)}"
           style="background: #25D366; color: white; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; display: inline-block;">
          Share on WhatsApp
        </a>
      </div>
    `,
  })
}
