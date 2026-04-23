import { Resend } from 'resend'

const FROM = 'Viewora <hello@viewora.software>'

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

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `New lead from your tour: ${spaceName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">You have a new lead!</h2>
        <p>Someone viewed your tour <strong>${spaceName}</strong> and left their details.</p>

        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Name:</strong> ${lead.name}</p>
          <p style="margin: 4px 0;"><strong>Email:</strong> <a href="mailto:${lead.email}">${lead.email}</a></p>
          ${lead.phone ? `<p style="margin: 4px 0;"><strong>Phone:</strong> ${lead.phone}</p>` : ''}
          ${lead.message ? `<p style="margin: 4px 0;"><strong>Message:</strong> ${lead.message}</p>` : ''}
        </div>

        <a href="https://app.viewora.software/app/spaces"
           style="background: #0066cc; color: white; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; display: inline-block;">
          View all leads
        </a>

        <p style="color: #888; font-size: 12px; margin-top: 32px;">
          This notification was sent because you have an active tour at
          viewora.software/p/${spaceSlug}
        </p>
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
  const tourUrl = `https://viewora.software/p/${spaceSlug}`

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `Your tour "${spaceName}" is live!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Your tour is live!</h2>
        <p>Your virtual tour <strong>${spaceName}</strong> is now published and ready to share.</p>

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
