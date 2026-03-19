import fp from 'fastify-plugin'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify({ audience: 'authenticated' })
      // The Supabase JWT payload is now available in `request.user`.
      // The user's UUID is stored in the `sub` property of the token.
    } catch (err: any) {
      request.log.warn({ 
        ip: request.ip, 
        route: request.url,
        message: err.message,
        code: err.code
      }, 'Unauthorized API access attempt block')
      
      reply.code(401).send({ 
        error: { 
          code: 'UNAUTHORIZED', 
          message: 'Invalid or missing token',
          detail: process.env.NODE_ENV === 'development' ? err.message : undefined
        } 
      })
    }
  })
})
