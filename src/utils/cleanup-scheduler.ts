import { FastifyInstance } from 'fastify'
import { createUploadQueue } from '../queues/upload.queue.js'
import {
  recordCleanupDeletedItems,
  recordCleanupFailure,
  recordCleanupJobCompletion,
} from './metrics.js'

/**
 * Scheduled Cleanup Jobs
 *
 * Runs periodically to:
 * - Clean up failed media (> 7 days)
 * - Remove orphan records
 * - Archive old unused assets
 */

export type CleanupTask = {
  name: string
  schedule: string // cron format or ISO duration
  execute: (fastify: FastifyInstance) => Promise<void>
}

/**
 * Daily cleanup of failed media
 * Runs at 2:00 AM UTC daily
 */
export const failedMediaCleanupTask: CleanupTask = {
  name: 'cleanup-failed-media',
  schedule: '0 2 * * *', // 2 AM UTC every day
  execute: async (fastify: FastifyInstance) => {
    fastify.log.info('Starting cleanup: failed media')

    try {
      // Find media that:
      // - Status is 'failed'
      // - Has been marked for cleanup (marked_for_cleanup = true)
      // - Was marked > 7 days ago

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const { data: failedMedia, error: queryErr } = await fastify.supabase
        .from('property_media')
        .select('id, storage_key, file_size_bytes, property_id')
        .eq('processing_status', 'failed')
        .eq('marked_for_cleanup', true)
        .lt('marked_for_cleanup_at', sevenDaysAgo)

      if (queryErr) {
        recordCleanupFailure(failedMediaCleanupTask.name, 'query')
        fastify.log.error({ error: queryErr }, 'Failed to query failed media for cleanup')
        return
      }

      if (!failedMedia || failedMedia.length === 0) {
        fastify.log.info('No failed media to clean up')
        return
      }

      fastify.log.info({ count: failedMedia.length }, 'Found failed media to clean up')

      let deletedCount = 0
      let errorCount = 0

      for (const media of failedMedia) {
        try {
          const { data: property } = await fastify.supabase
            .from('properties')
            .select('user_id')
            .eq('id', media.property_id)
            .single()

          // Safety guard: skip cleanup if property ownership cannot be verified.
          if (!property?.user_id) {
            errorCount++
            recordCleanupFailure(failedMediaCleanupTask.name, 'safety')
            fastify.log.error({ mediaId: media.id }, 'Skipped cleanup: could not verify property ownership')
            continue
          }

          // 1. Delete from R2
          if (media.storage_key) {
            try {
              const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
              const command = new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME!,
                Key: media.storage_key,
              })
              await (fastify as any).s3.send(command)
              fastify.log.debug({ mediaId: media.id }, 'Deleted from R2')
            } catch (error: any) {
              fastify.log.warn({ mediaId: media.id, error: error?.message }, 'Failed to delete from R2')
              // Continue anyway—DB cleanup is still important
            }
          }

          // 2. Delete DB record
          await fastify.supabase.from('property_media').delete().eq('id', media.id)

          // 3. Decrement storage counter
          if (media.file_size_bytes && property?.user_id) {
            await fastify.supabase.rpc('decrement_storage_usage', {
              u_id: property.user_id,
              bytes: media.file_size_bytes,
            })
          }

          deletedCount++
          fastify.log.debug({ mediaId: media.id }, 'Cleaned up failed media')
        } catch (error: any) {
          errorCount++
          recordCleanupFailure(failedMediaCleanupTask.name, 'item')
          fastify.log.error({ mediaId: media.id, error: error?.message }, 'Failed to clean up media')
        }
      }

      recordCleanupDeletedItems(failedMediaCleanupTask.name, deletedCount)

      fastify.log.info(
        { deletedCount, errorCount, total: failedMedia.length },
        'Cleanup task completed',
      )
    } catch (error: any) {
      recordCleanupFailure(failedMediaCleanupTask.name, 'task')
      fastify.log.error({ error: error?.message }, 'Cleanup task failed')
    }
  },
}

/**
 * Cleanup orphan media (media with no parent property)
 * Runs weekly
 */
export const orphanMediaCleanupTask: CleanupTask = {
  name: 'cleanup-orphan-media',
  schedule: '0 3 * * 0', // 3 AM UTC every Sunday
  execute: async (fastify: FastifyInstance) => {
    fastify.log.info('Starting cleanup: orphan media')

    try {
      // Find media where property_id doesn't exist in properties table
      const { data: orphanMedia, error: queryErr } = await fastify.supabase
        .rpc('find_orphan_media')

      if (queryErr) {
        recordCleanupFailure(orphanMediaCleanupTask.name, 'query')
        fastify.log.warn({ error: queryErr }, 'Could not query orphan media (RPC may not exist)')
        return
      }

      if (!orphanMedia || orphanMedia.length === 0) {
        fastify.log.info('No orphan media to clean up')
        return
      }

      fastify.log.info({ count: orphanMedia.length }, 'Found orphan media to clean up')

      let deletedCount = 0

      for (const media of orphanMedia) {
        try {
          // Delete from R2 if storage_key exists
          if (media.storage_key) {
            try {
              const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
              const command = new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME!,
                Key: media.storage_key,
              })
              await (fastify as any).s3.send(command)
            } catch (error: any) {
              fastify.log.warn({ mediaId: media.id, error: error?.message }, 'Failed to delete orphan from R2')
            }
          }

          // Delete DB record
          await fastify.supabase.from('property_media').delete().eq('id', media.id)
          deletedCount++
        } catch (error: any) {
          recordCleanupFailure(orphanMediaCleanupTask.name, 'item')
          fastify.log.error({ mediaId: media.id, error: error?.message }, 'Failed to delete orphan media')
        }
      }

      recordCleanupDeletedItems(orphanMediaCleanupTask.name, deletedCount)

      fastify.log.info({ deletedCount }, 'Orphan media cleanup completed')
    } catch (error: any) {
      recordCleanupFailure(orphanMediaCleanupTask.name, 'task')
      fastify.log.error({ error: error?.message }, 'Orphan media cleanup failed')
    }
  },
}

/**
 * Execute cleanup task
 */
export async function executeCleanupTask(
  fastify: FastifyInstance,
  task: CleanupTask,
): Promise<void> {
  const startedAt = Date.now()
  try {
    await task.execute(fastify)
    recordCleanupJobCompletion(task.name, 'success', Date.now() - startedAt)
  } catch (error: any) {
    recordCleanupFailure(task.name, 'task')
    recordCleanupJobCompletion(task.name, 'failed', Date.now() - startedAt)
    fastify.log.error({ task: task.name, error: error?.message }, 'Cleanup task execution failed')
  }
}

/**
 * All cleanup tasks
 */
export const cleanupTasks: CleanupTask[] = [
  failedMediaCleanupTask,
  orphanMediaCleanupTask,
]
