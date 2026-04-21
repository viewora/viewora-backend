import fp from 'fastify-plugin'
import { createClient } from 'redis'
import type { FastifyInstance } from 'fastify'

type RedisClient = ReturnType<typeof createClient>

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClient | null
  }
}

export default fp(async (fastify: FastifyInstance) => {
  if (!process.env.REDIS_URL) {
    fastify.decorate('redis', null)
    return
  }

  const client = createClient({ url: process.env.REDIS_URL })
  client.on('error', (err) => fastify.log.error({ err }, 'Redis client error'))
  await client.connect()
  fastify.decorate('redis', client)

  fastify.addHook('onClose', async () => {
    await client.quit()
  })
})
