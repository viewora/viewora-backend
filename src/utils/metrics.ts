import {
  Counter,
  Gauge,
  Histogram,
  register,
  collectDefaultMetrics,
} from 'prom-client'

/**
 * Prometheus Metrics
 *
 * Tracks:
 * - Job processing success/failure
 * - Queue depth and health
 * - Processing duration and latency
 */

// Collect default Node.js metrics (memory, CPU, etc.)
collectDefaultMetrics()

/**
 * Counter: Total number of jobs processed (success + failure)
 */
export const jobsProcessedTotal = new Counter({
  name: 'viewora_jobs_processed_total',
  help: 'Total number of media processing jobs completed (success or failure)',
  labelNames: ['outcome'], // 'success' or 'failed'
})

/**
 * Counter: Total number of job retries
 */
export const jobsRetriedTotal = new Counter({
  name: 'viewora_jobs_retried_total',
  help: 'Total number of times jobs were retried',
})

/**
 * Counter: Total number of jobs moved to dead-letter
 */
export const jobsDeadLetterTotal = new Counter({
  name: 'viewora_jobs_dead_letter_total',
  help: 'Total number of jobs moved to dead-letter queue (permanent failures after max retries)',
})

/**
 * Counter: Total number of jobs that stalled (timeout/hang detected)
 */
export const jobsStalledTotal = new Counter({
  name: 'viewora_jobs_stalled_total',
  help: 'Total number of jobs that stalled (timeout/hang detected)',
})

/**
 * Gauge: Current queue depth (waiting jobs)
 */
export const queueDepth = new Gauge({
  name: 'viewora_queue_depth',
  help: 'Current number of jobs waiting in the queue',
})

/**
 * Gauge: Currently active jobs (being processed)
 */
export const activeJobs = new Gauge({
  name: 'viewora_active_jobs',
  help: 'Current number of jobs actively being processed',
})

/**
 * Gauge: Failed jobs (in dead-letter queue)
 */
export const failedJobs = new Gauge({
  name: 'viewora_failed_jobs',
  help: 'Current number of jobs in dead-letter queue',
})

/**
 * Histogram: Job processing duration (milliseconds)
 *
 * Buckets: 100ms, 500ms, 1s, 2s, 5s, 10s
 * Shows: min, max, p50, p95, p99 processing time
 */
export const jobDurationMs = new Histogram({
  name: 'viewora_job_duration_ms',
  help: 'Job processing duration in milliseconds',
  buckets: [100, 500, 1000, 2000, 5000, 10000],
})

/**
 * Histogram: Upload file size (bytes)
 *
 * Helps track: typical upload sizes, large upload distribution
 */
export const uploadFileSizeBytes = new Histogram({
  name: 'viewora_upload_file_size_bytes',
  help: 'Upload file size in bytes',
  buckets: [
    100000, // 100KB
    500000, // 500KB
    1000000, // 1MB
    5000000, // 5MB
    10000000, // 10MB
    50000000, // 50MB
  ],
})

/**
 * Gauge: Current error rate (percentage)
 *
 * Calculated as: (failed in last hour) / (total in last hour) * 100
 * This is pseudo—real calculation should use prometheus queries
 */
export const errorRatePercent = new Gauge({
  name: 'viewora_error_rate_percent',
  help: 'Percentage of jobs that failed (over last hour window)',
})

/**
 * Counter: Cleanup job executions (by outcome)
 */
export const cleanupJobsTotal = new Counter({
  name: 'cleanup_jobs_total',
  help: 'Total number of cleanup job runs',
  labelNames: ['task', 'outcome'], // outcome: success | failed
})

/**
 * Counter: Total number of items deleted by cleanup tasks
 */
export const cleanupDeletedItemsTotal = new Counter({
  name: 'cleanup_deleted_items_total',
  help: 'Total number of records deleted by cleanup tasks',
  labelNames: ['task'],
})

/**
 * Counter: Cleanup failures (query, task, and item-level)
 */
export const cleanupFailuresTotal = new Counter({
  name: 'cleanup_failures_total',
  help: 'Total number of cleanup failures',
  labelNames: ['task', 'stage'],
})

/**
 * Histogram: Cleanup task duration in milliseconds
 */
export const cleanupDurationMs = new Histogram({
  name: 'cleanup_duration_ms',
  help: 'Cleanup task execution duration in milliseconds',
  labelNames: ['task'],
  buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 300000],
})

/**
 * Gauge: Last successful or failed cleanup run timestamp (unix seconds)
 */
export const cleanupLastRunTimestampSeconds = new Gauge({
  name: 'cleanup_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last cleanup job completion',
  labelNames: ['task'],
})

type CleanupTaskDashboardState = {
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  deletedItems: number
  failures: number
  lastOutcome: 'success' | 'failed' | 'never'
  lastRunAtUnix: number | null
  lastDurationMs: number | null
  totalDurationMs: number
}

const cleanupDashboardState = new Map<string, CleanupTaskDashboardState>()

function getOrCreateCleanupState(task: string): CleanupTaskDashboardState {
  const existing = cleanupDashboardState.get(task)
  if (existing) return existing

  const initial: CleanupTaskDashboardState = {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    deletedItems: 0,
    failures: 0,
    lastOutcome: 'never',
    lastRunAtUnix: null,
    lastDurationMs: null,
    totalDurationMs: 0,
  }
  cleanupDashboardState.set(task, initial)
  return initial
}

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics()
}

/**
 * Helper: Record job success
 */
export function recordJobSuccess(durationMs: number, fileSize?: number) {
  jobsProcessedTotal.inc({ outcome: 'success' })
  jobDurationMs.observe(durationMs)
  if (fileSize) {
    uploadFileSizeBytes.observe(fileSize)
  }
}

/**
 * Helper: Record job failure
 */
export function recordJobFailure(durationMs: number) {
  jobsProcessedTotal.inc({ outcome: 'failed' })
  jobDurationMs.observe(durationMs)
}

/**
 * Helper: Record job retry
 */
export function recordJobRetry() {
  jobsRetriedTotal.inc()
}

/**
 * Helper: Record job moved to dead-letter
 */
export function recordJobDeadLetter() {
  jobsDeadLetterTotal.inc()
}

/**
 * Helper: Record job stalled
 */
export function recordJobStalled() {
  jobsStalledTotal.inc()
}

/**
 * Helper: Update queue health metrics
 * Call this periodically (every 10 seconds) from a monitoring task
 */
export async function updateQueueMetrics(
  queueDepthValue: number,
  activeJobsValue: number,
  failedJobsValue: number,
) {
  queueDepth.set(queueDepthValue)
  activeJobs.set(activeJobsValue)
  failedJobs.set(failedJobsValue)

  // Calculate error rate (simple: failed / (queued + active + failed))
  const total = queueDepthValue + activeJobsValue + failedJobsValue
  if (total > 0) {
    const rate = (failedJobsValue / total) * 100
    errorRatePercent.set(rate)
  }
}

/**
 * Helper: Record cleanup job completion
 */
export function recordCleanupJobCompletion(
  task: string,
  outcome: 'success' | 'failed',
  durationMsValue: number,
) {
  const state = getOrCreateCleanupState(task)

  cleanupJobsTotal.inc({ task, outcome })
  cleanupDurationMs.observe({ task }, durationMsValue)
  const nowUnix = Math.floor(Date.now() / 1000)
  cleanupLastRunTimestampSeconds.set({ task }, nowUnix)

  state.totalRuns += 1
  state.totalDurationMs += durationMsValue
  state.lastDurationMs = durationMsValue
  state.lastRunAtUnix = nowUnix
  state.lastOutcome = outcome
  if (outcome === 'success') state.successfulRuns += 1
  if (outcome === 'failed') state.failedRuns += 1
}

/**
 * Helper: Record deleted items from cleanup
 */
export function recordCleanupDeletedItems(task: string, count: number) {
  if (count > 0) {
    const state = getOrCreateCleanupState(task)
    state.deletedItems += count
    cleanupDeletedItemsTotal.inc({ task }, count)
  }
}

/**
 * Helper: Record cleanup failure
 */
export function recordCleanupFailure(task: string, stage: 'query' | 'task' | 'item' | 'safety') {
  const state = getOrCreateCleanupState(task)
  state.failures += 1
  cleanupFailuresTotal.inc({ task, stage })
}

export function getCleanupDashboardState() {
  const tasks = Array.from(cleanupDashboardState.entries()).map(([task, state]) => {
    const successRate = state.totalRuns > 0 ? (state.successfulRuns / state.totalRuns) * 100 : 0
    const failureRate = state.totalRuns > 0 ? (state.failedRuns / state.totalRuns) * 100 : 0
    const avgDurationMs = state.totalRuns > 0 ? state.totalDurationMs / state.totalRuns : null

    return {
      task,
      totalRuns: state.totalRuns,
      successfulRuns: state.successfulRuns,
      failedRuns: state.failedRuns,
      deletedItems: state.deletedItems,
      failures: state.failures,
      successRate,
      failureRate,
      lastOutcome: state.lastOutcome,
      lastRunAtUnix: state.lastRunAtUnix,
      lastDurationMs: state.lastDurationMs,
      avgDurationMs,
    }
  })

  return {
    generatedAtUnix: Math.floor(Date.now() / 1000),
    tasks,
  }
}
