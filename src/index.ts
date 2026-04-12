import Fastify, { FastifyError } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import dotenv from 'dotenv'
import rawBody from 'fastify-raw-body'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'crypto'

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
import maintenanceRoutes from './routes/maintenance.js'
import adminRoutes from './routes/admin.js'

import { createUploadQueue } from './queues/upload.queue.js'
import type { Queue, Worker } from 'bullmq'
import { getMetrics } from './utils/metrics.js'
import { cleanupTasks, executeCleanupTask } from './utils/cleanup-scheduler.js'

dotenv.config()

// Extend FastifyInstance with uploadQueue decorator
declare module 'fastify' {
  interface FastifyInstance {
    uploadQueue?: Queue
    cleanupWorkers?: Worker[]
  }
}

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

type ApiSuccessEnvelope = {
  success: true
  data: unknown
  meta?: Record<string, unknown>
}

type ApiErrorEnvelope = {
  success: false
  code: string
  message: string
  fields?: Array<{ field: string; message: string }>
  meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): boolean {
  return isRecord(value) && typeof value.success === 'boolean'
}

function toErrorCode(statusCode: number, fallback?: string): string {
  if (fallback) return fallback
  if (statusCode === 400) return 'VALIDATION_ERROR'
  if (statusCode === 401) return 'UNAUTHORIZED'
  if (statusCode === 403) return 'FORBIDDEN'
  if (statusCode === 404) return 'NOT_FOUND'
  if (statusCode === 409) return 'CONFLICT'
  if (statusCode === 413) return 'FILE_TOO_LARGE'
  if (statusCode === 415) return 'UNSUPPORTED_MEDIA'
  if (statusCode === 422) return 'UNPROCESSABLE'
  if (statusCode === 429) return 'RATE_LIMITED'
  if (statusCode >= 500) return 'INTERNAL_ERROR'
  return 'ERROR'
}

function normalizeOriginPattern(value: string): string {
  return value.trim().toLowerCase()
}

function isOriginAllowed(origin: string, patterns: string[]): boolean {
  const normalizedOrigin = normalizeOriginPattern(origin)
  return patterns.some((pattern) => {
    if (!pattern) return false
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return regex.test(normalizedOrigin)
    }
    return normalizedOrigin === pattern
  })
}

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://viewora.software',
  'https://app.viewora.software',
  'https://*.vercel.app',
].map(normalizeOriginPattern)

const configuredCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(normalizeOriginPattern).filter(Boolean)
  : defaultCorsOrigins

// Register plugins
fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow non-browser clients and same-origin server-to-server requests.
    if (!origin) return cb(null, true)
    const allowed = isOriginAllowed(origin, configuredCorsOrigins)
    return cb(null, allowed)
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Origin', 'X-Request-Id'],
  credentials: true,
})

fastify.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true
})

// Supabase uses JWT for auth. We verify it using the Supabase JWT secret.
// IMPORTANT: Supabase JWTs always have aud: "authenticated"
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

// Initialize upload queue (only if REDIS_URL is available)
if (process.env.REDIS_URL) {
  const uploadQueue = createUploadQueue()
  fastify.decorate('uploadQueue', uploadQueue)
}

fastify.addHook('onRequest', async (request, reply) => {
  ;(request as any).receivedAt = Date.now()
  reply.header('X-Request-Id', request.id || randomUUID())
})

fastify.addHook('onResponse', async (request, reply) => {
  const receivedAt = Number((request as any).receivedAt || Date.now())
  const durationMs = Date.now() - receivedAt
  const userId = (request as any).identity?.id || (request.user as any)?.sub || null

  request.log.info({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'viewora-backend',
    requestId: request.id,
    userId,
    route: `${request.method} ${request.routeOptions.url || request.url}`,
    statusCode: reply.statusCode,
    durationMs,
    message: 'Request completed',
    meta: {},
  })
})

fastify.addHook('onSend', async (request, reply, payload) => {
  const statusCode = reply.statusCode
  if (statusCode === 204 || statusCode === 304) return payload

  const contentTypeHeader = reply.getHeader('content-type')
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.toLowerCase() : ''
  const isJsonLike = contentType.includes('application/json') || contentType === ''
  if (!isJsonLike) return payload

  if (typeof payload !== 'string') return payload

  let parsedPayload: unknown
  try {
    parsedPayload = JSON.parse(payload)
  } catch {
    return payload
  }

  if (isEnvelope(parsedPayload)) return payload

  if (statusCode >= 400) {
    const record = isRecord(parsedPayload) ? parsedPayload : {}
    const nestedError = isRecord(record.error) ? record.error : null
    const envelope: ApiErrorEnvelope = {
      success: false,
      code: typeof record.code === 'string'
        ? record.code
        : toErrorCode(
            statusCode,
            typeof record.error === 'string'
              ? record.error
              : typeof nestedError?.code === 'string'
                ? nestedError.code
                : undefined,
          ),
      message: typeof record.message === 'string'
        ? record.message
        : typeof record.statusMessage === 'string'
          ? record.statusMessage
          : typeof nestedError?.message === 'string'
            ? nestedError.message
          : 'Request failed',
    }

    if (Array.isArray(record.fields)) {
      envelope.fields = record.fields as Array<{ field: string; message: string }>
    }

    envelope.meta = {
      requestId: request.id,
      ...(isRecord(record.meta) ? record.meta : {}),
    }

    return JSON.stringify(envelope)
  }

  const successEnvelope: ApiSuccessEnvelope = {
    success: true,
    data: parsedPayload,
    meta: {
      requestId: request.id,
    },
  }

  return JSON.stringify(successEnvelope)
})

// Global Error Handler for Standardization
fastify.setErrorHandler(function (error: FastifyError, request, reply) {
  this.log.error({ err: error, reqId: request.id }, 'System Error')

  const statusCode = error.statusCode || 500
  const code = statusCode === 429
    ? 'RATE_LIMITED'
    : toErrorCode(statusCode, error.code)

  reply.status(statusCode).send({
    success: false,
    code,
    message: error.message || 'An unexpected error occurred',
    meta: {
      requestId: request.id,
    },
  })
})

// Root & Health check
fastify.get('/', async () => {
  return { 
    message: 'Welcome to Viewora API', 
    status: 'online', 
    rebranded: true,
    version: '1.0.0'
  }
})

fastify.get('/health', async () => {
  return { status: 'ok', service: 'Viewora API' }
})

// Prometheus metrics endpoint (public, no auth required)
fastify.get('/metrics', async (request, reply) => {
  reply.header('Content-Type', 'text/plain; version=0.0.4')
  return getMetrics()
})

// Routes
fastify.register(spaceRoutes, { prefix: '/spaces' })
fastify.register(billingRoutes, { prefix: '/billing' })
fastify.register(uploadsRoutes, { prefix: '/uploads' })
fastify.register(leadsRoutes, { prefix: '/leads' })
fastify.register(analyticsRoutes, { prefix: '/analytics' })
fastify.register(dashboardRoutes, { prefix: '/dashboard' })
fastify.register(profileRoutes, { prefix: '/profile' })
fastify.register(maintenanceRoutes, { prefix: '/maintenance' })
fastify.register(adminRoutes, { prefix: '/admin' })

// Alias for /plans (used by frontend dashboard) to avoid 404
fastify.get('/plans', async (request, reply) => {
  return reply.redirect('/billing/plans', 301)
})

fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    success: false,
    code: 'NOT_FOUND',
    message: `The route ${request.method}:${request.url} was not found on this server.`,
    meta: {
      hint: 'If you just rebranded, ensure your deployment is using the latest code with /spaces and /billing routes.',
      timestamp: new Date().toISOString(),
      requestId: request.id,
    }
  })
})

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000')
    await fastify.listen({ port, host: '0.0.0.0' })
    console.log(`✅ Server is running on port ${port}`)
    console.log(`🚀 Accessible at http://0.0.0.0:${port}`)

    // Schedule cleanup jobs if Redis is available
    if (process.env.REDIS_URL && fastify.uploadQueue) {
      try {
        const { Worker } = await import('bullmq')
        const workers: Worker[] = []

        for (const task of cleanupTasks) {
          const worker = new Worker(
            `cleanup-${task.name}`,
            async (job) => {
              console.log(`🧹 Executing cleanup task: ${task.name}`)
              await executeCleanupTask(fastify, task)
              return { completed: true }
            },
            {
              connection: {
                url: process.env.REDIS_URL,
              },
              autorun: false,
            },
          )

          // Schedule the task with cron
          await fastify.uploadQueue?.add(
            `cleanup-${task.name}`,
            {},
            {
              repeat: {
                pattern: task.schedule,
              },
            },
          )

          worker.on('completed', (job) => {
            console.log(`✅ Cleanup task completed: ${task.name}`)
          })

          worker.on('failed', (job, err) => {
            console.error(`❌ Cleanup task failed: ${task.name}`, err)
          })

          workers.push(worker)
          await worker.run()
        }

        fastify.decorate('cleanupWorkers', workers)
        console.log(`🗑️  Started ${workers.length} cleanup tasks`)
      } catch (error: any) {
        fastify.log.warn({ error: error?.message }, 'Failed to initialize cleanup tasks')
      }
    }
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`\n⏹️  Received ${signal}, shutting down gracefully...`)

  try {
    // Close cleanup workers
    if (fastify.cleanupWorkers) {
      for (const worker of fastify.cleanupWorkers) {
        await worker.close()
      }
      console.log('✅ Cleanup workers closed')
    }

    // Close upload queue
    if (fastify.uploadQueue) {
      await fastify.uploadQueue.close()
      console.log('✅ Upload queue closed')
    }

    // Close server
    await fastify.close()
    console.log('✅ Server closed')
    process.exit(0)
  } catch (error: any) {
    console.error('Error during shutdown:', error?.message)
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
