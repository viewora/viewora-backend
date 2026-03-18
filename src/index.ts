import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import dotenv from 'dotenv'

import authPlugin from './plugins/auth.js'
import supabasePlugin from './plugins/supabase.js'
import s3Plugin from './plugins/s3.js'

import propertiesRoutes from './routes/properties.js'
import billingRoutes from './routes/billing.js'
import uploadsRoutes from './routes/uploads.js'
import leadsRoutes from './routes/leads.js'
import analyticsRoutes from './routes/analytics.js'

dotenv.config()

const fastify = Fastify({
  logger: true
})

// Register plugins
fastify.register(cors, {
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['https://viewora.software', 'https://viewora.vercel.app'],
  credentials: true,
})

// Supabase uses JWT for auth. We verify it using the Supabase JWT secret.
fastify.register(jwt, {
  secret: process.env.SUPABASE_JWT_SECRET || 'fallback-secret-for-dev-only'
})

fastify.register(authPlugin)
fastify.register(supabasePlugin)
fastify.register(s3Plugin)

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', service: 'Viewora API' }
})

// Routes
fastify.register(propertiesRoutes, { prefix: '/properties' })
fastify.register(billingRoutes, { prefix: '/billing' })
fastify.register(uploadsRoutes, { prefix: '/uploads' })
fastify.register(leadsRoutes, { prefix: '/leads' })
fastify.register(analyticsRoutes, { prefix: '/analytics' })

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3001')
    await fastify.listen({ port, host: '0.0.0.0' })
    console.log(`Backend listening on port ${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
