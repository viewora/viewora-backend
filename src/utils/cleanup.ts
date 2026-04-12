import { FastifyInstance } from 'fastify'

/**
 * Cleanup Policies for Media Lifecycle
 *
 * This cleanup system ensures:
 * 1. Failed media doesn't bloat storage
 * 2. Orphan records are removed
 * 3. Old unused assets are cleaned up
 */

export type CleanupPolicy = {
  name: string
  description: string
  daysOld: number
  query: (daysOld: number) => Promise<string[]>
  cleanup: (fastify: FastifyInstance, mediaIds: string[]) => Promise<number>
}

/**
 * Failed Upload Cleanup Policy
 *
 * Removes media records that have been failed for more than X days
 * Only applies to media marked with marked_for_cleanup=true
 */
export const failedUploadCleanup: CleanupPolicy = {
  name: 'failed-upload-cleanup',
  description: 'Remove media that failed processing and was marked for cleanup after 7 days',
  daysOld: 7,
  query: async (daysOld: number) => {
    // This will be called by the cleanup scheduler
    // Returns array of media IDs to cleanup
    return []
  },
  cleanup: async (fastify: FastifyInstance, mediaIds: string[]): Promise<number> => {
    if (mediaIds.length === 0) return 0

    let cleanedCount = 0

    for (const mediaId of mediaIds) {
      try {
        // 1. Get the media record
        const { data: media } = await fastify.supabase
          .from('property_media')
          .select('storage_key, file_size_bytes')
          .eq('id', mediaId)
          .single()

        if (!media) continue

        // 2. Delete from R2
        if (media.storage_key) {
          try {
            const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
            const command = new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME!,
              Key: media.storage_key,
            })
            await (fastify as any).s3.send(command)
          } catch (error: any) {
            fastify.log.warn({ mediaId, error: error?.message }, 'Failed to delete from R2')
            // Continue anyway—DB record cleanup is important
          }
        }

        // 3. Delete DB record
        await fastify.supabase.from('property_media').delete().eq('id', mediaId)

        // 4. Decrement storage counter
        if (media.file_size_bytes) {
          // Get owner via property join
          const { data: record } = await fastify.supabase
            .from('property_media')
            .select('property_id')
            .eq('id', mediaId)
            .single()

          if (record?.property_id) {
            const { data: property } = await fastify.supabase
              .from('properties')
              .select('user_id')
              .eq('id', record.property_id)
              .single()

            if (property?.user_id) {
              await fastify.supabase.rpc('decrement_storage_usage', {
                u_id: property.user_id,
                bytes: media.file_size_bytes,
              })
            }
          }
        }

        cleanedCount++
        fastify.log.info({ mediaId }, 'Cleaned up failed media')
      } catch (error: any) {
        fastify.log.error({ mediaId, error: error?.message }, 'Failed to cleanup media')
      }
    }

    return cleanedCount
  },
}

/**
 * Run cleanup policies
 *
 * This should be called periodically (e.g., via a cron job or separate scheduled task)
 */
export async function runCleanupPolicies(fastify: FastifyInstance) {
  fastify.log.info('Starting media cleanup policies...')

  // For now, this is a skeleton
  // In production, you would:
  // 1. Query for media matching cleanup criteria
  // 2. Call cleanup() for each matching policy
  // 3. Log results
  //
  // Example:
  // const failedMedia = await fastify.supabase
  //   .from('property_media')
  //   .select('id')
  //   .eq('processing_status', 'failed')
  //   .eq('marked_for_cleanup', true)
  //   .lt('marked_for_cleanup_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  //
  // const mediaIds = failedMedia.data?.map((m: any) => m.id) || []
  // const cleanedCount = await failedUploadCleanup.cleanup(fastify, mediaIds)
  // fastify.log.info({ cleanedCount }, 'Cleanup policies completed')
}

/**
 * Schedule cleanup policies to run periodically
 *
 * This should be called when the server starts:
 * - Run cleanup daily (e.g., 2 AM)
 * - Run cleanup on startup (with delay to allow startup)
 * - Run cleanup after upload failures (optional, triggered by admin endpoint)
 */
export async function scheduleCleanupPolicies(fastify: FastifyInstance) {
  // TODO: Implement scheduled cleanup
  // Use: node-cron or a simple setInterval for MVP
  // Production: use a proper job scheduler (APScheduler, Celery, etc.)

  fastify.log.info('Cleanup policies scheduled (skeleton, not yet implemented)')
}
