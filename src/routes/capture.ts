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
  dept:          z.string().trim().max(60).optional(),
  planName:      z.string().trim().max(40).optional(),
})

const idParamsSchema = z.object({ id: z.string().uuid() })

const patchStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled']),
})

export default async function captureRoutes(fastify: FastifyInstance) {

  // POST /capture/request — submit a booking
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
    const spaceName   = body.spaceName   ? sanitizeLeadText(body.spaceName, 120)   : null
    const notes       = body.notes       ? sanitizeLeadText(body.notes, 1000)      : null
    const serviceName = body.serviceName ? sanitizeLeadText(body.serviceName, 120) : 'Capture Service'
    const servicePrice = body.servicePrice ?? 'TBD'

    // Persist the booking request
    const { data: saved, error: insertErr } = await fastify.supabase
      .from('capture_requests')
      .insert({
        user_id:        user.sub,
        service_id:     body.serviceId     ?? null,
        service_name:   serviceName,
        service_price:  servicePrice,
        dept:           body.dept          ?? null,
        name,
        email,
        phone,
        address,
        space_name:     spaceName,
        preferred_date: body.preferredDate ?? null,
        notes,
        plan_name:      body.planName      ?? null,
      })
      .select()
      .single()

    if (insertErr) {
      // Non-fatal: log but still send emails and return 201
      fastify.log.error(insertErr, 'Failed to persist capture request')
    }

    // Fire emails (non-blocking)
    void sendCaptureRequestEmail({
      userEmail: email,
      userName:  name,
      serviceName,
      servicePrice,
      phone,
      address,
      spaceName,
      preferredDate: body.preferredDate ?? null,
      notes,
      planName:      body.planName      ?? null,
    }).catch((err) => fastify.log.error(err, 'Capture email send failed'))

    fastify.log.info({ userId: user.sub, serviceId: body.serviceId, serviceName, email }, 'Capture request received')
    return reply.code(201).send({ statusMessage: 'Booking request received', id: saved?.id ?? null })
  })

  // GET /capture/requests — list the current user's bookings
  fastify.get('/requests', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const { data, error } = await fastify.supabase
      .from('capture_requests')
      .select('*')
      .eq('user_id', user.sub)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch bookings' })
    }
    return reply.send({ data: data ?? [] })
  })

  // PATCH /capture/requests/:id — update booking status
  fastify.patch('/requests/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, patchStatusSchema, request.body)
    if (!body) return

    const { data, error } = await fastify.supabase
      .from('capture_requests')
      .update({ status: body.status })
      .eq('id', params.id)
      .eq('user_id', user.sub)
      .select('id, status')
      .single()

    if (error || !data) return reply.code(404).send({ statusMessage: 'Booking not found' })
    return reply.send(data)
  })
}
