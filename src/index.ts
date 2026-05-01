import Fastify, { FastifyError } from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import jwt from '@fastify/jwt'
import dotenv from 'dotenv'
import rawBody from 'fastify-raw-body'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'crypto'

import authPlugin from './plugins/auth.js'
import redisPlugin from './plugins/redis.js'
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
import scenesRoutes from './routes/scenes.js'
import hotspotsRoutes from './routes/hotspots.js'
import publicRoutes from './routes/public.js'
import internalRoutes from './routes/internal.js'

import { createUploadQueue } from './queues/upload.queue.js'
import type { Queue } from 'bullmq'
import { getMetrics } from './utils/metrics.js'
import { cleanupTasks, executeCleanupTask } from './utils/cleanup-scheduler.js'
import { initSentry, captureException } from './utils/sentry.js'

dotenv.config()

// Register global error handlers early — before any async operations — so that
// any unhandled promise rejection or uncaught exception during startup is logged
// and causes a clean exit instead of a silent crash.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled promise rejection:', reason)
  process.exit(1)
})

process.on('uncaughtException', (err: Error) => {
  console.error('Uncaught exception:', err)
  process.exit(1)
})

// initSentry is async (dynamic ESM import) — fire-and-forget; errors are caught internally
void initSentry()

// Extend FastifyInstance with uploadQueue decorator
declare module 'fastify' {
  interface FastifyInstance {
    uploadQueue?: Queue
    cleanupIntervals?: NodeJS.Timeout[]
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
  logger: true,
  bodyLimit: 262144000, // 250MB
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

// Compression — brotli preferred, gzip fallback. Must be first.
fastify.register(compress, { global: true, encodings: ['br', 'gzip'] })

// Redis cache pool
fastify.register(redisPlugin)

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
  maxAge: 86400, // Cache preflight for 24h — eliminates repeated OPTIONS round-trips
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
  timeWindow: '1 minute',
  // Rate limit per authenticated user (falls back to IP for unauthenticated requests)
  keyGenerator: (request: any) => {
    const user = request.user
    return user?.sub || user?.id || request.ip
  },
  // Exempt health checks from rate limiting
  allowList: (request: any) => request.url === '/health' || request.url === '/',
})

// Initialize upload queue (only if REDIS_URL is available)
if (process.env.REDIS_URL) {
  const uploadQueue = createUploadQueue()
  fastify.decorate('uploadQueue', uploadQueue)
}

fastify.addHook('onRequest', async (request, reply) => {
  ;(request as any).receivedAt = Date.now()
  reply.header('X-Request-Id', request.id || randomUUID())
  // Security headers on every response
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  reply.header('X-Permitted-Cross-Domain-Policies', 'none')
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

  // Report unhandled 5xx errors to Sentry
  if (statusCode >= 500) {
    captureException(error, { requestId: request.id, url: request.url, method: request.method })
  }

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

fastify.get('/health', async (request, reply) => {
  if (fastify.redis) {
    try {
      await fastify.redis.ping()
    } catch {
      return reply.code(503).send({ status: 'unhealthy', reason: 'redis' })
    }
  }
  return { status: 'ok', service: 'Viewora API' }
})

// Prometheus metrics endpoint — restrict to internal/Railway health probes
fastify.get('/metrics', async (request, reply) => {
  const allowedToken = process.env.METRICS_TOKEN
  if (allowedToken) {
    const authHeader = request.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${allowedToken}`) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
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
// New routes (no prefix — mixed URL shapes: /spaces/:id/scenes, /scenes/:id, /hotspots/:id, etc.)
fastify.register(scenesRoutes)
fastify.register(hotspotsRoutes)
fastify.register(publicRoutes)
fastify.register(internalRoutes)

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

    // Schedule cleanup tasks with setInterval.
    // Daily task runs every 24h, orphan task runs every 7 days.
    // Both fire once after a 2-minute warmup delay so the server is fully ready.
    const CLEANUP_INTERVAL_MS: Record<string, number> = {
      'cleanup-failed-media': 24 * 60 * 60 * 1000,
      'cleanup-orphan-media': 7 * 24 * 60 * 60 * 1000,
    }

    // Lock TTL slightly under the repeat interval so the lock expires before the next run.
    const CLEANUP_LOCK_TTL_S: Record<string, number> = {
      'cleanup-failed-media': 23 * 60 * 60,           // 23h — daily task
      'cleanup-orphan-media': 6 * 24 * 60 * 60 + 23 * 60 * 60, // ~6d 23h — weekly task
    }

    const cleanupIntervals: NodeJS.Timeout[] = []

    for (const task of cleanupTasks) {
      const intervalMs = CLEANUP_INTERVAL_MS[task.name] ?? 24 * 60 * 60 * 1000
      const lockTtlSeconds = CLEANUP_LOCK_TTL_S[task.name] ?? 82800

      // Initial run after 2-minute warmup
      const warmup = setTimeout(async () => {
        fastify.log.info({ task: task.name }, 'Running initial cleanup task')
        await executeCleanupTask(fastify, task, lockTtlSeconds)
      }, 2 * 60 * 1000)

      // Recurring run on interval
      const recurring = setInterval(async () => {
        fastify.log.info({ task: task.name }, 'Running scheduled cleanup task')
        await executeCleanupTask(fastify, task, lockTtlSeconds)
      }, intervalMs)

      cleanupIntervals.push(warmup, recurring)
    }

    fastify.decorate('cleanupIntervals', cleanupIntervals)
    fastify.log.info(`Scheduled ${cleanupTasks.length} cleanup tasks`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start().catch(err => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`\n⏹️  Received ${signal}, shutting down gracefully...`)

  try {
    // Clear cleanup intervals
    if (fastify.cleanupIntervals) {
      for (const interval of fastify.cleanupIntervals) {
        clearInterval(interval)
      }
      console.log('✅ Cleanup intervals cleared')
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
