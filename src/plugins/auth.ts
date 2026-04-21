import fp from 'fastify-plugin'
import { createHash } from 'crypto'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { checkUserQuota } from '../utils/quotas.js'

type RequestIdentity = {
  id: string
  plan: {
    id: string | null
    name: string
    isFree: boolean
  }
  permissions: {
    canWrite: boolean
    leadCaptureEnabled: boolean
    brandingCustomizationEnabled: boolean
    embedsEnabled: boolean
    qrDownloadEnabled: boolean
    advancedAnalyticsEnabled: boolean
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }

  interface FastifyRequest {
    identity?: RequestIdentity
  }
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } })
    }

    const token = authHeader.split(' ')[1]

    // Cache key: hash of token, short enough for Redis key limits
    const cacheKey = `identity:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`

    try {
      // Check Redis cache first — avoids a remote Supabase Auth call + DB query per request
      if (fastify.redis) {
        const cached = await fastify.redis.get(cacheKey).catch(() => null)
        if (cached) {
          const parsed = JSON.parse(cached)
          request.user = parsed.user
          request.identity = parsed.identity
          return
        }
      }

      // Use Supabase directly to verify the token.
      // This handles ES256/HS256 and key rotation automatically.
      const { data: { user }, error } = await fastify.supabase.auth.getUser(token)

      if (error || !user) {
        request.log.warn({ error: error?.message }, 'Auth failed')
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
            detail: process.env.NODE_ENV === 'development' ? error?.message : undefined
          }
        })
      }

      // Attach user to request.
      // Existing routes expect request.user.sub (JWT standard)
      request.user = {
        ...user,
        sub: user.id
      } as any

      try {
        const { plan, canWrite, isFree } = await checkUserQuota(fastify, user.id)
        request.identity = {
          id: user.id,
          plan: {
            id: typeof plan.id === 'string' ? plan.id : null,
            name: String(plan.name || 'Free'),
            isFree,
          },
          permissions: {
            canWrite,
            leadCaptureEnabled: Boolean(plan.lead_capture_enabled),
            brandingCustomizationEnabled: Boolean(plan.branding_customization_enabled),
            embedsEnabled: Boolean(plan.embeds_enabled),
            qrDownloadEnabled: Boolean(plan.qr_download_enabled),
            advancedAnalyticsEnabled: Boolean(plan.advanced_analytics_enabled),
          },
        }
      } catch (quotaError: any) {
        request.log.warn({ err: quotaError?.message }, 'Failed to enrich identity context from quota data')
        request.identity = {
          id: user.id,
          plan: {
            id: null,
            name: 'Unknown',
            isFree: true,
          },
          permissions: {
            canWrite: false,
            leadCaptureEnabled: false,
            brandingCustomizationEnabled: false,
            embedsEnabled: false,
            qrDownloadEnabled: false,
            advancedAnalyticsEnabled: false,
          },
        }
      }

      // Cache the verified identity for 55s (tokens valid for 60s of inactivity)
      if (fastify.redis && request.user && request.identity) {
        void fastify.redis.setEx(cacheKey, 55, JSON.stringify({
          user: request.user,
          identity: request.identity,
        })).catch(() => {})
      }
    } catch (err: any) {
      request.log.error(`Auth exception: ${err.message}`)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication error' } })
    }
  })
})
