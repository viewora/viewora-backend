import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
import { getCleanupDashboardState } from '../utils/metrics.js'

export default async function (fastify: FastifyInstance) {
  // Basic auth middleware for admin routes
  fastify.addHook('preHandler', async (request, reply) => {
    const adminSecret = process.env.ADMIN_SECRET
    if (!adminSecret) {
      return reply.code(401).send({ statusMessage: 'Admin secret not configured' })
    }

    const authHeader = request.headers.authorization
    const expected = `Bearer ${adminSecret}`
    let authorized = false
    try {
      if (authHeader && authHeader.length === expected.length) {
        authorized = timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
      }
    } catch {
      authorized = false
    }
    if (!authorized) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }
  })

  // Get queue instance
  const getQueue = () => {
    const queue = (fastify as any).uploadQueue
    if (!queue) {
      throw new Error('Upload queue not available')
    }
    return queue
  }

  /**
   * GET /admin/cleanup-health
   * Dashboard-friendly cleanup health snapshot
   */
  fastify.get('/cleanup-health', async (_request, reply) => {
    try {
      const snapshot = getCleanupDashboardState()
      return reply.send({
        success: true,
        data: snapshot,
      })
    } catch (error: any) {
      fastify.log.error({ error: error?.message }, 'Failed to fetch cleanup health snapshot')
      return reply.code(500).send({
        statusMessage: 'Failed to fetch cleanup health snapshot',
      })
    }
  })

  /**
   * GET /admin/failed-jobs
   * List all failed media processing jobs
   */
  fastify.get('/failed-jobs', async (request, reply) => {
    try {
      const queue = getQueue()

      // Get all failed jobs
      const failedJobs = await queue.getFailed()

      // Transform to readable format
      const jobs = failedJobs.map((job: any) => ({
        jobId: job.id,
        mediaId: job.data.mediaId,
        spaceId: job.data.spaceId,
        userId: job.data.userId,
        objectKey: job.data.objectKey,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stackTrace: job.stacktrace?.[0] || null,
        createdTimestamp: job.timestamp,
      }))

      return reply.send({
        success: true,
        data: {
          count: jobs.length,
          jobs,
        },
      })
    } catch (error: any) {
      fastify.log.error({ error: error?.message }, 'Failed to fetch failed jobs')
      return reply.code(500).send({
        statusMessage: 'Failed to fetch failed jobs',
      })
    }
  })

  /**
   * GET /admin/queue-stats
   * Get current queue statistics
   */
  fastify.get('/queue-stats', async (request, reply) => {
    try {
      const queue = getQueue()

      // Get queue counts
      const waitingCount = await queue.count()
      const failedCount = await queue.getFailed()
      const activeCount = await queue.getActiveCount()
      const completedCount = await queue.getCompletedCount()

      return reply.send({
        success: true,
        data: {
          waiting: waitingCount,
          active: activeCount,
          completed: completedCount,
          failed: failedCount.length,
          isPaused: await queue.isPaused(),
        },
      })
    } catch (error: any) {
      fastify.log.error({ error: error?.message }, 'Failed to fetch queue stats')
      return reply.code(500).send({
        statusMessage: 'Failed to fetch queue stats',
      })
    }
  })

  /**
   * POST /admin/retry-job/:jobId
   * Manually retry a specific failed job
   */
  fastify.post<{ Params: { jobId: string } }>(
    '/retry-job/:jobId',
    async (request, reply) => {
      try {
        const { jobId } = request.params
        const queue = getQueue()

        // Find the failed job
        const job = await queue.getJob(jobId)
        if (!job) {
          return reply.code(404).send({ statusMessage: 'Job not found' })
        }

        // Check if it's failed
        const state = await job.getState()
        if (state !== 'failed') {
          return reply.code(409).send({
            statusMessage: `Can only retry failed jobs. Current state: ${state}`,
          })
        }

        // Reset attempts and re-enqueue
        await job.retry()

        fastify.log.info(
          { jobId, mediaId: job.data.mediaId },
          'Admin manually retried job',
        )

        return reply.send({
          success: true,
          data: {
            jobId,
            mediaId: job.data.mediaId,
            status: 'requeued',
          },
        })
      } catch (error: any) {
        fastify.log.error({ error: error?.message }, 'Failed to retry job')
        return reply.code(500).send({
          statusMessage: 'Failed to retry job',
        })
      }
    }
  )

  /**
   * POST /admin/failed-media/cleanup
   * Mark all permanently failed media as ready for cleanup
   * (This is used by Step 4: Cleanup Policies)
   */
  fastify.post('/failed-media/cleanup', async (request, reply) => {
    try {
      const queue = getQueue()
      const failedJobs = await queue.getFailed()

      let cleanedCount = 0

      for (const job of failedJobs) {
        const { mediaId } = job.data

        // Mark media record with cleanup flag
        const result = await fastify.supabase
          .from('property_media')
          .update({
            marked_for_cleanup: true,
            marked_for_cleanup_at: new Date().toISOString(),
          })
          .eq('id', mediaId)
          .eq('processing_status', 'failed')

        if (result.error) {
          fastify.log.error(
            { mediaId, error: result.error },
            'Failed to mark media for cleanup',
          )
        } else {
          cleanedCount++
        }
      }

      fastify.log.info(
        { cleanedCount, totalFailed: failedJobs.length },
        'Marked failed media for cleanup',
      )

      return reply.send({
        success: true,
        data: {
          markedForCleanup: cleanedCount,
          totalFailed: failedJobs.length,
        },
      })
    } catch (error: any) {
      fastify.log.error(
        { error: error?.message },
        'Failed to cleanup failed media',
      )
      return reply.code(500).send({
        statusMessage: 'Failed to cleanup failed media',
      })
    }
  })

  /**
   * DELETE /admin/failed-job/:jobId
   * Permanently remove a failed job from the queue
   */
  fastify.delete<{ Params: { jobId: string } }>(
    '/failed-job/:jobId',
    async (request, reply) => {
      try {
        const { jobId } = request.params
        const queue = getQueue()

        const job = await queue.getJob(jobId)
        if (!job) {
          return reply.code(404).send({ statusMessage: 'Job not found' })
        }

        const mediaId = job.data.mediaId
        await job.remove()

        fastify.log.warn(
          { jobId, mediaId },
          'Admin permanently deleted failed job',
        )

        return reply.send({
          success: true,
          data: { jobId, mediaId, deleted: true },
        })
      } catch (error: any) {
        fastify.log.error({ error: error?.message }, 'Failed to delete job')
        return reply.code(500).send({
          statusMessage: 'Failed to delete job',
        })
      }
    }
  )
}
