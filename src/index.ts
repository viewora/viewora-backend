import Fastify, { FastifyError } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import dotenv from 'dotenv'
import rawBody from 'fastify-raw-body'
import rateLimit from '@fastify/rate-limit'

import authPlugin from './plugins/auth.js'
import supabasePlugin from './plugins/supabase.js'
import s3Plugin from './plugins/s3.js'

import spaceRoutes from './routes/spaces.js'
import billingRoutes from './routes/billing.js'
import uploadsRoutes from './routes/uploads.js'
import leadsRoutes from './routes/leads.js'
import analyticsRoutes from './routes/analytics.js'
import dashboardRoutes from './routes/dashboard.js'
import profileRoutes from './routes/profile.js'

dotenv.config()

// Fail fast on startup if required env vars are missing
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_JWT_SECRET',
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

const fastify = Fastify({
  logger: true
})

// Register plugins
fastify.register(cors, {
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:3001', 'https://viewora.software', 'https://app.viewora.software'],
  credentials: true,
})

fastify.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true
})

// Supabase uses JWT for auth. We verify it using the Supabase JWT secret.
fastify.register(jwt, {
  secret: process.env.SUPABASE_JWT_SECRET!
})

fastify.register(authPlugin)
fastify.register(supabasePlugin)
fastify.register(s3Plugin)

fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
})

// Global Error Handler for Standardization
fastify.setErrorHandler(function (error: FastifyError, request, reply) {
  this.log.error({ err: error, reqId: request.id }, 'System Error')
  
  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' }
    })
  }
  
  reply.status(error.statusCode || 500).send({
    error: {
      code: error.code || 'INTERNAL_SERVER_ERROR',
      message: error.message || 'An unexpected error occurred'
    }
  })
})

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', service: 'Viewora API' }
})

// Routes
fastify.register(spaceRoutes, { prefix: '/spaces' })
fastify.register(billingRoutes, { prefix: '/billing' })
fastify.register(uploadsRoutes, { prefix: '/uploads' })
fastify.register(leadsRoutes, { prefix: '/leads' })
fastify.register(analyticsRoutes, { prefix: '/analytics' })
fastify.register(dashboardRoutes, { prefix: '/dashboard' })
fastify.register(profileRoutes, { prefix: '/profile' })

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
