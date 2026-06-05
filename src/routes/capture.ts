import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'
import { sendCaptureRequestEmail } from '../email/index.js'

const captureRequestBodySchema = z.object({
  name:          z.string().trim().min(1).max(100),
  email:         z.string().trim().email().max(254),
  phone:         z.string().trim().min(1).max(30),
  address:       z.string().trim().min(1).max(300),
  spaceName:     z.string().trim().max(120).optional(),
  preferredDate: z.string().trim().max(20).optional(),
  notes:         z.string().trim().max(1000).optional(),
  serviceId:     z.string().trim().max(60).optional(),
  serviceName:   z.string().trim().max(120).optional(),
  servicePrice:  z.string().trim().max(40).optional(),
  planName:      z.string().trim().max(40).optional(),
})

export default async function captureRoutes(fastify: FastifyInstance) {
  fastify.post('/request', {
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req: any) => req.user?.sub ?? req.ip },
    },
  }, async (request, reply) => {
    const user = request.user as any
    const body = parseWithSchema(reply, captureRequestBodySchema, request.body)
    if (!body) return

    const name        = sanitizeLeadText(body.name, 100)
    const email       = body.email.trim().toLowerCase()
    const phone       = sanitizeLeadText(body.phone, 30)
    const address     = sanitizeLeadText(body.address, 300)
    const spaceName   = body.spaceName   ? sanitizeLeadText(body.spaceName, 120)  : null
    const notes       = body.notes       ? sanitizeLeadText(body.notes, 1000)     : null
    const serviceName = body.serviceName ? sanitizeLeadText(body.serviceName, 120): 'Capture Service'
    const servicePrice = body.servicePrice ?? 'TBD'

    // Fire confirmation + ops notification emails (non-blocking)
    void sendCaptureRequestEmail({
      userEmail:     email,
      userName:      name,
      serviceName,
      servicePrice,
      phone,
      address,
      spaceName,
      preferredDate: body.preferredDate ?? null,
      notes,
      planName:      body.planName ?? null,
    }).catch((err) => fastify.log.error(err, 'Capture email send failed'))

    fastify.log.info(
      { userId: user.sub, serviceId: body.serviceId, serviceName, email },
      'Capture request received'
    )

    return reply.code(201).send({ statusMessage: 'Booking request received' })
  })
}
