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
        .select('id, storage_key, file_size_bytes, property_id, properties!inner(user_id)')
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
      let freedBytes = 0

      for (const media of failedMedia) {
        try {
          const userId = (media.properties as any)?.user_id

          // Safety guard: skip cleanup if property ownership cannot be verified.
          // !inner join already filters orphan media, but guard defensively.
          if (!userId) {
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
            } catch (error: any) {
              fastify.log.warn({ mediaId: media.id, error: error?.message }, 'Failed to delete from R2')
              // Continue anyway — DB cleanup is still important
            }
          }

          // 2. Delete DB record
          await fastify.supabase.from('property_media').delete().eq('id', media.id)

          // 3. Decrement storage counter
          if (media.file_size_bytes) {
            await fastify.supabase.rpc('decrement_storage_usage', {
              u_id: userId,
              bytes: media.file_size_bytes,
            })
            freedBytes += Number(media.file_size_bytes)
          }

          deletedCount++
        } catch (error: any) {
          errorCount++
          recordCleanupFailure(failedMediaCleanupTask.name, 'item')
          fastify.log.error({ mediaId: media.id, error: error?.message }, 'Failed to clean up media')
        }
      }

      recordCleanupDeletedItems(failedMediaCleanupTask.name, deletedCount)

      fastify.log.info(
        { deletedCount, errorCount, total: failedMedia.length, freedBytes },
        'Failed-media cleanup complete',
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
      let freedBytes = 0

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
          if (media.file_size_bytes) freedBytes += Number(media.file_size_bytes)
          deletedCount++
        } catch (error: any) {
          recordCleanupFailure(orphanMediaCleanupTask.name, 'item')
          fastify.log.error({ mediaId: media.id, error: error?.message }, 'Failed to delete orphan media')
        }
      }

      recordCleanupDeletedItems(orphanMediaCleanupTask.name, deletedCount)

      fastify.log.info({ deletedCount, freedBytes, total: orphanMedia.length }, 'Orphan media cleanup completed')
    } catch (error: any) {
      recordCleanupFailure(orphanMediaCleanupTask.name, 'task')
      fastify.log.error({ error: error?.message }, 'Orphan media cleanup failed')
    }
  },
}

/**
 * Execute cleanup task with a distributed Redis lock so only one instance
 * runs each task at a time. lockTtlSeconds should be slightly less than the
 * task's repeat interval so the lock expires before the next scheduled run.
 */
export async function executeCleanupTask(
  fastify: FastifyInstance,
  task: CleanupTask,
  lockTtlSeconds = 82800,  // default 23h — safe for a daily task
): Promise<void> {
  // Acquire distributed lock — prevents duplicate runs across Railway instances
  if (fastify.redis) {
    const lockKey = `cleanup:lock:${task.name}`
    const acquired = await fastify.redis
      .set(lockKey, '1', { NX: true, EX: lockTtlSeconds })
      .catch(() => null)
    if (!acquired) {
      fastify.log.info({ task: task.name }, 'Cleanup skipped — lock held by another instance')
      return
    }
  }

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
 * Sweep R2 objects that were presigned but never completed (/uploads/complete never called).
 * These rows have processing_status = 'pending_upload' and are older than 2 hours.
 * Runs every 6 hours.
 */
export const stalePendingUploadCleanupTask: CleanupTask = {
  name: 'cleanup-stale-pending-uploads',
  schedule: '0 */6 * * *', // every 6 hours
  execute: async (fastify: FastifyInstance) => {
    fastify.log.info('Starting cleanup: stale pending_upload rows')

    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

      const { data: staleRows, error: queryErr } = await fastify.supabase
        .from('property_media')
        .select('id, storage_key, file_size_bytes, properties!inner(user_id)')
        .eq('processing_status', 'pending_upload')
        .lt('created_at', twoHoursAgo)

      if (queryErr) {
        recordCleanupFailure(stalePendingUploadCleanupTask.name, 'query')
        fastify.log.error({ error: queryErr }, 'Failed to query stale pending_upload rows')
        return
      }

      if (!staleRows || staleRows.length === 0) {
        fastify.log.info('No stale pending_upload rows to clean up')
        return
      }

      fastify.log.info({ count: staleRows.length }, 'Found stale pending_upload rows')

      let deletedCount = 0

      for (const row of staleRows) {
        try {
          // Delete the R2 object (the file was uploaded but the user never completed the flow)
          if (row.storage_key && process.env.R2_BUCKET_NAME) {
            try {
              const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
              await (fastify as any).s3.send(new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: row.storage_key,
              }))
            } catch (r2Err: any) {
              fastify.log.warn({ id: row.id, error: r2Err?.message }, 'R2 delete failed for stale pending_upload')
            }
          }

          // Delete the placeholder DB row
          await fastify.supabase.from('property_media').delete().eq('id', row.id)
          deletedCount++
        } catch (err: any) {
          recordCleanupFailure(stalePendingUploadCleanupTask.name, 'item')
          fastify.log.error({ id: row.id, error: err?.message }, 'Failed to clean stale pending_upload row')
        }
      }

      recordCleanupDeletedItems(stalePendingUploadCleanupTask.name, deletedCount)
      fastify.log.info({ deletedCount, total: staleRows.length }, 'Stale pending_upload cleanup complete')
    } catch (err: any) {
      recordCleanupFailure(stalePendingUploadCleanupTask.name, 'task')
      fastify.log.error({ error: err?.message }, 'Stale pending_upload cleanup task failed')
    }
  },
}

/**
 * All cleanup tasks
 */
export const cleanupTasks: CleanupTask[] = [
  failedMediaCleanupTask,
  orphanMediaCleanupTask,
  stalePendingUploadCleanupTask,
]
