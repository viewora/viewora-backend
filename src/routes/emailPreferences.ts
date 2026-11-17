import { FastifyInstance, FastifyReply } from 'fastify'
import { verifyUnsubscribeToken } from '../email/unsubscribe.js'

// GET  /email/unsubscribe?token=…  → confirmation page with a button.
//      It does NOT unsubscribe by itself: corporate link scanners (Outlook
//      Safe Links, Mimecast…) open every link in an email, and would
//      otherwise unsubscribe people who never clicked.
// POST /email/unsubscribe?token=…  → unsubscribes. This is also what Gmail /
//      Yahoo call for their one-click "Unsubscribe" button (RFC 8058), with a
//      form-encoded body of `List-Unsubscribe=One-Click`.

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · Viewora</title>
<style>
  body{font-family:Arial,sans-serif;background:#f9fafb;color:#1a1a1a;margin:0;padding:48px 16px}
  main{max-width:440px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center}
  h1{font-size:20px;margin:0 0 12px} p{color:#4b5563;line-height:1.6;margin:0 0 20px}
  button{background:#0a0a0b;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:bold;cursor:pointer}
  a{color:#0066cc}
</style></head><body><main>${body}</main></body></html>`)
}

const invalid = (reply: FastifyReply) =>
  page(reply, 400, 'Link not valid',
    `<h1>This link isn't valid</h1><p>It may have been copied incompletely. Email
     <a href="mailto:support@viewora.software">support@viewora.software</a> and we'll unsubscribe you.</p>`)

export default async function emailPreferencesRoutes(fastify: FastifyInstance) {
  // Gmail/Yahoo post `List-Unsubscribe=One-Click` form-encoded. Fastify has
  // no urlencoded parser by default; the body content is irrelevant here, so
  // accept it as a plain string. Scoped to this plugin only.
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
    (_req, body, done) => done(null, body))

  fastify.get('/email/unsubscribe', async (req, reply) => {
    const token = (req.query as Record<string, unknown>).token
    if (!verifyUnsubscribeToken(token)) return invalid(reply)
    const action = `/email/unsubscribe?token=${encodeURIComponent(String(token))}`
    return page(reply, 200, 'Unsubscribe',
      `<h1>Unsubscribe from Viewora tips and reports?</h1>
       <p>You'll stop getting setup tips, weekly lead digests and monthly reports.
          Billing and account emails will still arrive.</p>
       <form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`)
  })

  fastify.post('/email/unsubscribe', async (req, reply) => {
    const userId = verifyUnsubscribeToken((req.query as Record<string, unknown>).token)
    if (!userId) return invalid(reply)

    const { error } = await fastify.supabase
      .from('profiles')
      .update({ marketing_emails_opted_out_at: new Date().toISOString() })
      .eq('id', userId)
      .is('marketing_emails_opted_out_at', null)

    if (error) {
      fastify.log.error({ error: error.message, userId }, 'email/unsubscribe: update failed')
      return page(reply, 500, 'Something went wrong',
        `<h1>Something went wrong</h1><p>Please try again, or email
         <a href="mailto:support@viewora.software">support@viewora.software</a> and we'll unsubscribe you.</p>`)
    }

    fastify.log.info({ userId }, 'email/unsubscribe: opted out of marketing emails')
    return page(reply, 200, 'Unsubscribed',
      `<h1>You're unsubscribed</h1><p>You won't get Viewora tips or reports any more.
       Billing and account emails will still arrive.</p>`)
  })
}
