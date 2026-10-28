// Follow-ups and wording (under /admin/quote). The staff check runs in
// quoteAdmin.ts first.
//
//   GET  /templates                       every editable wording, with history
//   PUT  /templates/:key/:channel         save a new version (admin)
//   POST /templates/preview               render wording with example values
//   GET  /followups/tasks                 WhatsApp messages waiting for staff to send
//   POST /followups/tasks/:id/sent        staff sent it from their WhatsApp
//   POST /followups/tasks/:id/skip        staff decided not to send it
//   GET  /leads/:id/followups             a lead's sequences and to-dos
//   POST /leads/:id/followups/stop        "they replied" (or stop for another reason)
//   POST /leads/:id/opt-out               the lead asked not to be contacted
//   GET  /messaging-settings              PUT /messaging-settings (admin)

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { allowed } from '../quote/staffAuth.js'
import type { FollowupStore } from '../quote/followupStore.js'
import { SAMPLE_VARS, SEQUENCES, TEMPLATE_CATALOG, checkPlaceholders, templateInfo, type MessagingSettings } from '../quote/followups.js'
import { render } from '../quote/alerts.js'
import { inQuietHours } from '../quote/desk.js'

const id = z.object({ id: z.string().uuid() })
const channel = z.enum(['whatsapp', 'email'])
const templateParams = z.object({ key: z.string().regex(/^[a-z_]{1,40}$/), channel })
const templateBody = z.object({
  subject: z.string().trim().max(200).nullable(),
  body: z.string().trim().min(1).max(4000),
})
const settingsBody = z.object({
  weeklyCap: z.number().int().min(1).max(14),
  highValueAmount: z.number().int().min(1).max(100_000_000).nullable(),
  highValueEmails: z.array(z.string().trim().toLowerCase().email().max(254)).max(10),
  reviewUrl: z.string().trim().url().max(500).refine(u => u.startsWith('https://'), 'Use an https:// link').nullable(),
})
const stopBody = z.object({ reason: z.enum(['replied', 'staff']) })

const STEP_LABELS: Record<string, string> = {
  resume_whatsapp: 'Finish-your-quote WhatsApp', resume_email: 'Finish-your-quote email',
  quote_ready: 'The quote link', not_opened: 'Nudge if not opened', not_accepted: '"Anything to adjust?"', expiring: 'Expiry reminder',
  review: 'Review request', hosting_offer: 'Hosting offer', renewal: 'Renewal reminder',
}

export default async function quoteFollowupRoutes(fastify: FastifyInstance, opts: { followups: FollowupStore; now: () => Date }) {
  const { followups, now } = opts

  fastify.get('/templates', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const versions = await followups.templates()
    return {
      templates: TEMPLATE_CATALOG.flatMap(info => info.channels.map(ch => {
        const history = versions.filter(v => v.key === info.key && v.channel === ch)
        return { ...info, channel: ch, current: history[0] ?? null, history: history.slice(0, 20) }
      })),
      sample: SAMPLE_VARS,
    }
  })

  fastify.post('/templates/preview', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const body = parseWithSchema(reply, templateBody.extend(templateParams.shape), request.body)
    if (!body) return
    const info = templateInfo(body.key)
    if (!info) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No wording with that name.' })
    return {
      subject: body.subject ? render(body.subject, SAMPLE_VARS) : null,
      body: render(body.body, SAMPLE_VARS),
      check: checkPlaceholders(info, [body.subject ?? '', body.body]),
    }
  })

  fastify.put('/templates/:key/:channel', async (request, reply) => {
    if (!allowed(request, reply, 'templates:write')) return
    const params = parseWithSchema(reply, templateParams, request.params)
    const body = params && parseWithSchema(reply, templateBody, request.body)
    if (!params || !body) return
    const info = templateInfo(params.key)
    if (!info || !info.channels.includes(params.channel)) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No wording with that name.' })
    if (params.channel === 'email' && !body.subject) return reply.code(422).send({ code: 'SUBJECT_REQUIRED', statusMessage: 'An email needs a subject line.' })
    const { unknown, missing } = checkPlaceholders(info, [body.subject ?? '', body.body])
    if (unknown.length) {
      return reply.code(422).send({ code: 'UNKNOWN_PLACEHOLDER', statusMessage: `This wording cannot fill ${unknown.map(p => `{{${p}}}`).join(', ')}. Use one of the placeholders listed.`, unknown })
    }
    if (missing.length) {
      return reply.code(422).send({ code: 'MISSING_PLACEHOLDER', statusMessage: `Keep ${missing.map(p => `{{${p}}}`).join(', ')} in the message, or the client gets no link.`, missing })
    }
    const version = await followups.saveTemplate(params.key, params.channel, params.channel === 'email' ? body.subject : null, body.body, request.quoteStaff!.id)
    return { version }
  })

  fastify.get('/followups/tasks', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const tasks = await followups.tasks()
    return { quietHours: inQuietHours(now()), tasks: tasks.map(withLink) }
  })

  for (const outcome of ['sent', 'skip'] as const) {
    fastify.post(`/followups/tasks/:id/${outcome}`, async (request, reply) => {
      if (!allowed(request, reply, 'leads:write')) return
      const params = parseWithSchema(reply, id, request.params)
      if (!params) return
      const done = await followups.finishTask(params.id, request.quoteStaff!.id, outcome === 'sent' ? 'sent' : 'skipped', now().toISOString())
      if (!done) return reply.code(409).send({ code: 'TASK_DONE', statusMessage: 'Someone already handled this message, or the follow-up stopped.' })
      return { ok: true }
    })
  }

  fastify.get('/leads/:id/followups', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const [sequences, tasks] = await Promise.all([followups.sequences(params.id), followups.tasks(params.id)])
    return {
      quietHours: inQuietHours(now()),
      sequences: sequences.map(s => {
        const def = SEQUENCES[s.key]
        const next = s.status === 'active' ? def?.steps[s.nextStep] : undefined
        return { ...s, label: def?.label ?? s.key, nextLabel: next ? STEP_LABELS[next.id] ?? next.id : null }
      }),
      tasks: tasks.map(withLink),
    }
  })

  fastify.post('/leads/:id/followups/stop', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const params = parseWithSchema(reply, id, request.params)
    const body = params && parseWithSchema(reply, stopBody, request.body)
    if (!params || !body) return
    return { stopped: await followups.stop(params.id, body.reason, request.quoteStaff!.id) }
  })

  fastify.post('/leads/:id/opt-out', async (request, reply) => {
    if (!allowed(request, reply, 'leads:write')) return
    const params = parseWithSchema(reply, id, request.params)
    if (!params) return
    const ok = await followups.optOut(params.id, request.quoteStaff!.id, 'staff')
    if (!ok) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No lead with that id.' })
    return { optedOut: true }
  })

  fastify.get('/messaging-settings', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    return { settings: await followups.settings() }
  })

  fastify.put('/messaging-settings', async (request, reply) => {
    if (!allowed(request, reply, 'settings:write')) return
    const body = parseWithSchema(reply, settingsBody, request.body)
    if (!body) return
    const value: MessagingSettings = { ...body, highValueEmails: [...new Set(body.highValueEmails)] }
    await followups.saveSettings(value, request.quoteStaff!.id)
    return { settings: value }
  })
}

// The click-to-chat link staff open: their WhatsApp, this number, this text
function withLink<T extends { whatsappE164: string | null; body: string; sequenceStep: string | null }>(task: T) {
  return {
    ...task,
    label: task.sequenceStep ? STEP_LABELS[task.sequenceStep] ?? null : null,
    waUrl: task.whatsappE164 ? `https://wa.me/${task.whatsappE164.replace(/\D/g, '')}?text=${encodeURIComponent(task.body)}` : null,
  }
}
