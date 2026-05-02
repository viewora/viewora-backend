import { FastifyInstance } from 'fastify'
import type { ProcessMediaJob } from '../queues/upload.queue.js'

export type UploadStatus = 'pending' | 'processing' | 'complete' | 'failed'

export async function updateUploadStatus(
  fastify: FastifyInstance,
  mediaId: string,
  status: UploadStatus,
  errorMessage?: string | null,
) {
  const updates: Record<string, unknown> = {
    processing_status: status,
    updated_at: new Date().toISOString(),
  }

  if (status === 'complete') {
    updates.processed_at = new Date().toISOString()
    updates.processing_error = null
  }

  if (status === 'failed') {
    updates.processing_error = errorMessage || 'Processing failed'
  }

  await fastify.supabase
    .from('property_media')
    .update(updates)
    .eq('id', mediaId)
}

/**
 * Queue a media processing job
 * This enqueues the job to BullMQ for asynchronous processing
 * The worker process will pick it up and process it with automatic retries
 */
export async function scheduleMediaProcessing(
  fastify: FastifyInstance,
  mediaId: string,
  spaceId: string,
  userId: string,
  objectKey: string,
) {
  // Get the upload queue from fastify context
  const uploadQueue = (fastify as any).uploadQueue

  if (!uploadQueue) {
    fastify.log.error({ mediaId }, 'uploadQueue not initialized — cannot process media')
    await updateUploadStatus(fastify, mediaId, 'failed', 'Queue unavailable — retry later')
    return
  }

  const jobData: ProcessMediaJob = {
    mediaId,
    spaceId,
    userId,
    objectKey,
  }

  try {
    const job = await uploadQueue.add('process-media', jobData)
    fastify.log.info({ mediaId, jobId: job.id }, 'Media processing job queued')
  } catch (error: any) {
    fastify.log.error({ mediaId, error: error?.message }, 'Failed to queue media processing job')
    // Mark as failed since we couldn't queue it
    await updateUploadStatus(fastify, mediaId, 'failed', 'Failed to queue for processing')
  }
}
