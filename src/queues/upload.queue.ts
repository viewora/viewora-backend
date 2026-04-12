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

// Redis connection configuration
const redisHost = process.env.REDIS_HOST || 'localhost'
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10)
const redisPassword = process.env.REDIS_PASSWORD

const redisOptions = {
  host: redisHost,
  port: redisPort,
  ...(redisPassword && { password: redisPassword }),
  maxRetriesPerRequest: null,
}

/**
 * Shared Redis client instance
 * Used by queue producers and consumers
 */
export function createRedisConnection() {
  return createClient({
    url: process.env.REDIS_URL || `redis://${redisHost}:${redisPort}`,
  })
}

/**
 * Create the media processing queue
 * This is used by the API to enqueue jobs
 */
export function createUploadQueue() {
  return new Queue<ProcessMediaJob>(UPLOAD_QUEUE_NAME, {
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
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10)
  
  return new Worker<ProcessMediaJob>(UPLOAD_QUEUE_NAME, processor, {
    connection: redisOptions,
    concurrency, // Configurable via WORKER_CONCURRENCY env var
    maxStalledCount: 2, // Mark job as stalled after 2 lock losses (timeout prevention)
  })
}
