import dotenv from 'dotenv'
import { createUploadWorker, createUploadQueue, createUploadQueueEvents, type ProcessMediaJob } from './queues/upload.queue.js'
import { createClient } from 'redis'
import Fastify from 'fastify'
import supabasePlugin from './plugins/supabase.js'
import s3Plugin from './plugins/s3.js'
import { processMedia } from './utils/media-processor.js'
import { updateUploadStatus } from './utils/uploads.js'
import { processTileScene } from './utils/tile-processor.js'
import {
  recordJobSuccess,
  recordJobFailure,
  recordJobRetry,
  recordJobDeadLetter,
  recordJobStalled,
  updateQueueMetrics,
} from './utils/metrics.js'

dotenv.config()

// Validate required environment variables
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_URL',
]
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

// Create a minimal Fastify instance for database and S3 access
const fastify = Fastify({ logger: true })
await fastify.register(supabasePlugin)
await fastify.register(s3Plugin)

// Create Redis client for cleanup
const redis = createClient({
  url: process.env.REDIS_URL,
})

// Create queue events listener
const queueEvents = createUploadQueueEvents()

// Job processor function
async function processUploadJob(job: any) {
  // Route tile-scene jobs to the tile processor
  if (job.name === 'tile-scene') {
    const { sceneId, rawImageUrl, spaceId } = job.data
    await processTileScene(fastify.s3, fastify.supabase, { sceneId, rawImageUrl, spaceId })
    return
  }

  const { mediaId, spaceId, userId, objectKey } = job.data as ProcessMediaJob
  const jobId = job.id
  const attempt = job.attemptsMade + 1
  const maxAttempts = 5
  const startTime = Date.now()

  fastify.log.info(
    { 
      jobId,
      mediaId, 
      spaceId, 
      userId, 
      objectKey, 
      attempt, 
      maxAttempts,
    },
    `Processing upload job (attempt ${attempt}/${maxAttempts})`,
  )

  try {
    // Mark job as processing
    await updateUploadStatus(fastify, mediaId, 'processing')

    // Process the media file
    await processMedia(fastify, mediaId, objectKey, userId)

    const durationMs = Date.now() - startTime
    fastify.log.info(
      { 
        jobId,
        mediaId, 
        durationMs,
        attempt,
      }, 
      'Media processing job completed successfully',
    )

    // Record metrics
    recordJobSuccess(durationMs)
  } catch (error: any) {
    const durationMs = Date.now() - startTime
    const isLastAttempt = attempt === maxAttempts
    const failureReason = error?.message || error?.code || 'Unknown error'

    fastify.log.error(
      { 
        jobId,
        mediaId, 
        attempt, 
        maxAttempts, 
        isLastAttempt,
        durationMs,
        failureReason,
      },
      'Media processing job failed',
    )

    // Record metrics
    if (isLastAttempt) {
      recordJobFailure(durationMs)
      recordJobDeadLetter()
    } else {
      recordJobRetry()
    }

    // If this is the last attempt, mark as permanently failed
    if (isLastAttempt) {
      await updateUploadStatus(
        fastify,
        mediaId,
        'failed',
        `Failed after ${maxAttempts} attempts: ${failureReason}`,
      )
      fastify.log.warn(
        { 
          jobId,
          mediaId,
          failureReason,
        }, 
        'Media processing moved to dead-letter (permanent failure)',
      )
    }

    // Re-throw to let BullMQ handle retry
    throw error
  }
}

// Create the worker
const worker = createUploadWorker(processUploadJob)

// Reuse a single queue instance for metric polling — never close it inside the interval
const metricsQueue = createUploadQueue()

// BullMQ emits 'error' for Redis connection issues; without a listener
// Node.js converts them to uncaughtException which kills the process.
worker.on('error', (err) => console.error('BullMQ worker error:', err))
metricsQueue.on('error', (err) => console.error('BullMQ metricsQueue error:', err))
queueEvents.on('error', (err) => console.error('BullMQ queueEvents error:', err))

// Monitor queue events for better observability
queueEvents.on('failed', (data: any) => {
  const { jobId, failedReason } = data
  fastify.log.error({ jobId, failedReason }, 'Job failed event from queue')
})

queueEvents.on('completed', (data: any) => {
  const { jobId } = data
  fastify.log.info({ jobId }, 'Job completed event from queue')
})

queueEvents.on('stalled', (data: any) => {
  const { jobId } = data
  fastify.log.warn({ jobId }, 'Job stalled (may indicate timeout or hang)')
  recordJobStalled()
})

// Periodic queue health update — reuses single metricsQueue connection
setInterval(async () => {
  try {
    const [waitingCount, activeCount, failedJobs] = await Promise.all([
      metricsQueue.count(),
      metricsQueue.getActiveCount(),
      metricsQueue.getFailed(),
    ])
    await updateQueueMetrics(waitingCount, activeCount, failedJobs.length)
  } catch (error: any) {
    fastify.log.error({ error: error?.message }, 'Failed to update queue metrics')
  }
}, 10000)

// Graceful shutdown
const shutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`)

  try {
    await worker.close()
    await queueEvents.close()
    await metricsQueue.close()
    await redis.quit()
    await fastify.close()
    fastify.log.info('Worker shutdown complete')
    process.exit(0)
  } catch (error: any) {
    fastify.log.error({ error: error?.message }, 'Error during shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

fastify.log.info('Upload worker started, listening for jobs...')
