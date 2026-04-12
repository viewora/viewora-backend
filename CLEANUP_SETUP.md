# Cleanup Job System - Setup & Management Guide

## Overview

The Viewora backend now includes automated scheduled cleanup jobs that run periodically to:
- Clean up failed media (> 7 days old)
- Remove orphan media records
- Reclaim storage space and database resources

## Architecture

### Components

1. **cleanup-scheduler.ts** - Defines cleanup tasks with cron schedules
   - `failedMediaCleanupTask` - Runs daily at 2 AM UTC
   - `orphanMediaCleanupTask` - Runs every Sunday at 3 AM UTC

2. **cleanup-rpc.sql** - Database RPC functions and indexes
   - `find_orphan_media()` - Finds media with no parent property
   - Cleanup-optimized indexes

3. **index.ts** - Server integration
   - Initializes cleanup workers on startup
   - Graceful shutdown handling

## Setup Instructions

### 1. Apply Database Migrations

Run the SQL from `cleanup-rpc.sql` in your Supabase dashboard:

```bash
# Via Supabase Dashboard:
1. Go to SQL Editor
2. Create a new query
3. Paste contents of src/utils/cleanup-rpc.sql
4. Execute
```

Or via psql:
```bash
psql $SUPABASE_DATABASE_URL < src/utils/cleanup-rpc.sql
```

### 2. Ensure Redis is Configured

The cleanup system requires Redis (or Asynq) for job scheduling:

```bash
# .env
REDIS_URL=redis://localhost:6379

# Or with password:
REDIS_URL=redis://user:password@host:port
```

### 3. Deploy Updated Code

Deploy the changes to use the new cleanup system:
```bash
npm run build
npm run deploy
```

## Task Schedules

### Daily: Failed Media Cleanup
- **When**: 2:00 AM UTC daily
- **What**: Removes media marked as failed and flagged for cleanup for > 7 days
- **Action**:
  - Deletes from R2 storage
  - Removes database record
  - Updates user storage quota

### Weekly: Orphan Media Cleanup
- **When**: Sunday 3:00 AM UTC
- **What**: Removes media records whose parent property no longer exists
- **Action**:
  - Deletes from R2 storage
  - Removes orphan database records

## Monitoring

### View Cleanup Logs

```bash
# In the server logs, look for:
# 🧹 Starting cleanup: failed-media
# ✅ Cleanup task completed: cleanup-failed-media
# ❌ Cleanup task failed
```

### Check Job Status

Via Redis CLI:
```bash
redis-cli
> KEYS "job:cleanup-*"
> GET job:cleanup-failed-media
> ZCARD bull:cleanup-failed-media:waiting
```

### Database Checks

```sql
-- Find media marked for cleanup
SELECT id, processing_status, marked_for_cleanup_at, file_size_bytes
FROM property_media
WHERE processing_status = 'failed' AND marked_for_cleanup = true
ORDER BY marked_for_cleanup_at DESC
LIMIT 20;

-- Find orphan media
SELECT * FROM find_orphan_media();

-- Check storage by user
SELECT 
  user_id,
  SUM(file_size_bytes) as total_bytes,
  SUM(file_size_bytes) / 1024.0 / 1024.0 / 1024.0 as total_gb
FROM property_media
GROUP BY user_id
ORDER BY total_bytes DESC;
```

## Customization

### Change Cleanup Schedules

Edit `src/utils/cleanup-scheduler.ts`:

```typescript
// Change the cron schedule
// Format: "minute hour day-of-month month day-of-week"
export const failedMediaCleanupTask: CleanupTask = {
  name: 'cleanup-failed-media',
  schedule: '0 3 * * *', // Now runs at 3 AM instead of 2 AM
  execute: async (fastify: FastifyInstance) => {
    // ...
  },
}
```

### Change Failed Media Threshold

Edit cleanup-scheduler.ts, `failedMediaCleanupTask` function:

```typescript
// Change from 7 days to 14 days
const sevenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
```

### Add New Cleanup Tasks

1. Create a new `CleanupTask` object:
```typescript
export const myCleanupTask: CleanupTask = {
  name: 'cleanup-my-thing',
  schedule: '0 4 * * *', // 4 AM UTC daily
  execute: async (fastify: FastifyInstance) => {
    // Your cleanup logic
  },
}
```

2. Add to the `cleanupTasks` array:
```typescript
export const cleanupTasks: CleanupTask[] = [
  failedMediaCleanupTask,
  orphanMediaCleanupTask,
  myCleanupTask, // Add here
]
```

3. Redeploy the server

## Troubleshooting

### Cleanup Tasks Not Running

1. Check Redis connection:
   ```bash
   redis-cli ping
   ```

2. Check server logs for worker initialization:
   ```
   🗑️  Started 2 cleanup tasks
   ```

3. Verify `REDIS_URL` environment variable is set

### High Memory Usage During Cleanup

If cleanup is causing memory spikes, add pagination:

```typescript
// Process in batches instead of all at once
const batchSize = 100
let offset = 0

while (true) {
  const { data: batch } = await fastify.supabase
    .from('property_media')
    .select('id, storage_key, file_size_bytes')
    .eq('processing_status', 'failed')
    .order('id')
    .range(offset, offset + batchSize - 1)

  if (!batch || batch.length === 0) break
  
  // Process batch...
  offset += batchSize
}
```

## Safety Features

1. **Soft Delete** - Media is marked for cleanup before being permanently deleted
2. **Time-based** - Failed media only cleaned after 7 days
3. **Logging** - All cleanup operations are logged
4. **Error Handling** - Failures don't stop the entire cleanup
5. **Graceful Shutdown** - Workers are properly closed on server shutdown

## Performance Optimization

### Index Usage
```sql
-- Cleanup queries use these indexes for fast lookups:
CREATE INDEX idx_property_media_cleanup
  ON property_media (processing_status, marked_for_cleanup, marked_for_cleanup_at)
  WHERE processing_status = 'failed' AND marked_for_cleanup = true;
```

### Batch Processing
- Orphan cleanup queries join tables efficiently
- Failed media processed one at a time to prevent memory issues
- R2 deletions are attempted even if DB operations fail

## Alerts & Monitoring (Recommended)

Set up monitoring alerts for:
```
1. Cleanup task failure count > 0 in the last 6 hours
2. Cleanup task duration > 30 minutes
3. Redis queue size growing (jobs not being processed)
4. Failed media count exceeding 1000 records
```

## Related Files
- [upload-queue.ts](./upload.queue.ts) - Upload processing queue
- [upload-utils.ts](./upload-utils.ts) - Media utilities
- [S3 Plugin](../plugins/s3.ts) - R2 storage integration
