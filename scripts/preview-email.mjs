/**
 * Renders the welcome email HTML to /tmp/email-preview.html and opens it in the browser.
 * Run with: node scripts/preview-email.mjs
 */
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const name = process.argv[2] || 'Cosmas'
const firstName = name.trim().split(' ')[0]
const greeting = `Hi ${firstName},`

const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="background:#f3f4f6; margin:0; padding:32px;">
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

  <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; background:#fff;">
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
      <a href="https://www.tiktok.com/@viewora.software" target="_blank"
         style="display: inline-block; margin: 0 4px; text-decoration: none;">
        <img src="https://viewora.software/icon-tiktok.png" alt="TikTok"
             width="24" height="24" style="display: block;" />
      </a>
      <a href="https://www.instagram.com/vieworasoftware/" target="_blank"
         style="display: inline-block; margin: 0 4px; text-decoration: none;">
        <img src="https://viewora.software/icon-instagram.png" alt="Instagram"
             width="24" height="24" style="display: block;" />
      </a>
    </div>
  </div>
</div>
</body>
</html>
`

const outPath = '/tmp/email-preview.html'
writeFileSync(outPath, html)
console.log(`Preview written to ${outPath}`)

try {
  execSync(`xdg-open ${outPath}`)
} catch {
  console.log(`Open manually: xdg-open ${outPath}`)
}
