import { Queue, Worker, QueueEvents } from 'bullmq'
import { createClient } from 'redis'

// Job data structure for media processing
export interface ProcessMediaJob {
  mediaId: string
  spaceId: string
  userId: string
  objectKey: string
}

// Queue names
export const UPLOAD_QUEUE_NAME = 'media-processing'

// Redis connection configuration for BullMQ/ioredis.
// Priority: REDIS_URL (Railway) -> REDIS_HOST/PORT/PASSWORD fallback.
function getBullMqRedisOptions() {
  const redisUrl = process.env.REDIS_URL

  if (redisUrl) {
    const parsed = new URL(redisUrl)
    const isTls = parsed.protocol === 'rediss:'
    const port = parsed.port ? parseInt(parsed.port, 10) : (isTls ? 6380 : 6379)

    return {
      host: parsed.hostname,
      port,
      ...(parsed.password ? { password: parsed.password } : {}),
      ...(parsed.username ? { username: parsed.username } : {}),
      ...(isTls ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    }
  }

  const redisHost = process.env.REDIS_HOST || 'localhost'
  const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10)
  const redisPassword = process.env.REDIS_PASSWORD

  return {
    host: redisHost,
    port: redisPort,
    ...(redisPassword ? { password: redisPassword } : {}),
    maxRetriesPerRequest: null,
  }
}

const redisOptions = getBullMqRedisOptions()

/**
 * Shared Redis client instance
 * Used by queue producers and consumers
 */
export function createRedisConnection() {
  return createClient({
    url: process.env.REDIS_URL || `redis://${redisOptions.host}:${redisOptions.port}`,
  })
}

/**
 * Create the media processing queue
 * This is used by the API to enqueue jobs
 */
export function createUploadQueue() {
  return new Queue<any>(UPLOAD_QUEUE_NAME, {
    connection: redisOptions,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000, // Start with 1s, exponential backoff
      },
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for inspection
    },
  })
}

/**
 * Create a queue events listener
 * Useful for monitoring queue health
 */
export function createUploadQueueEvents() {
  return new QueueEvents(UPLOAD_QUEUE_NAME, {
    connection: redisOptions,
  })
}

/**
 * Create the worker for processing jobs
 * This is used by the worker process to process jobs
 */
export function createUploadWorker(processor: (job: any) => Promise<void>) {
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '1', 10)
  
  return new Worker<any>(UPLOAD_QUEUE_NAME, processor, {
    connection: redisOptions,
    concurrency,
    lockDuration: 5 * 60 * 1000, // 5 min — covers worst-case 12K panorama tiling (~60s + upload headroom)
    stalledInterval: 15 * 1000,  // check for stalled jobs every 15s after lock expiry
    maxStalledCount: 2,
  })
}
