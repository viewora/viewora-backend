import fp from 'fastify-plugin'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } })
    }

    const token = authHeader.split(' ')[1]

    try {
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
    } catch (err: any) {
      request.log.error(`Auth exception: ${err.message}`)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication error' } })
    }
  })
})
