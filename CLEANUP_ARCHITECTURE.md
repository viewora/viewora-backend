# Viewora Backend Cleanup System - Architecture & Integration

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Viewora Backend Server                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Server Startup (index.ts)                           │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │ 1. Initialize plugins                       │    │   │
│  │  │ 2. Create upload queue (Redis)              │    │   │
│  │  │ 3. Initialize cleanup workers               │    │   │
│  │  │ 4. Schedule cleanup jobs                    │    │   │
│  │  │ 5. Start listening on port                  │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ↓                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Job Scheduling (BullMQ + Redis)                    │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │ Daily (2 AM): Failed Media Cleanup          │    │   │
│  │  │ Weekly (3 AM Sunday): Orphan Cleanup        │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ↓                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Cleanup Workers                                      │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │ Worker 1: Failed Media Cleanup              │    │   │
│  │  │ Worker 2: Orphan Media Cleanup              │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↙                ↙                                    │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────┐   │
│  │  Supabase    │  │  R2 Storage     │  │  Redis       │   │
│  │  Database    │  │  (Cleanup)      │  │  (Jobs)      │   │
│  └──────────────┘  └─────────────────┘  └──────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘

Graceful Shutdown
     ↓
Close workers → Close queue → Close server → Exit
```

## 📊 Data Flow

### Failed Media Cleanup Flow

```
BullMQ Scheduler (2 AM UTC)
           ↓
   Worker executes
           ↓
Query Supabase:
  SELECT * FROM property_media
  WHERE status='failed' AND marked_for_cleanup=true AND marked_at < 7 days ago
           ↓
For each media item:
  ├─ DELETE from R2 storage (storage_key)
  ├─ DELETE from property_media table
  └─ Call decrement_storage_usage RPC
           ↓
Update metrics & log results
           ↓
Update failed count in Redis queue
```

### Orphan Media Cleanup Flow

```
BullMQ Scheduler (3 AM UTC Sunday)
           ↓
   Worker executes
           ↓
Query via RPC:
  SELECT * FROM find_orphan_media()
  (finds media where property_id doesn't exist)
           ↓
For each orphan item:
  ├─ DELETE from R2 storage
  └─ DELETE from property_media table
           ↓
Log cleanup results
```

## 🔗 Integration Points

### 1. Server Initialization (`index.ts`)
```typescript
// On startup:
- Import cleanup tasks
- Create upload queue (Redis)
- Initialize workers with cleanup logic
- Schedule jobs with cron patterns
- Add shutdown handlers
```

### 2. Database Integration (`cleanup-rpc.sql`)
```sql
-- RPC function for orphan detection
CREATE FUNCTION find_orphan_media()
  RETURNS TABLE(id uuid, storage_key text, file_size_bytes bigint)
  
-- Indexes for performance
CREATE INDEX idx_property_media_cleanup
  ON property_media (processing_status, marked_for_cleanup)
```

### 3. Storage Integration (`cleanup-scheduler.ts`)
```typescript
// Uses S3 client (R2) for deletion
DELETE object from storage_key
// Handles errors gracefully - continues if storage fails
```

### 4. Management Tools (`cleanup-manager.sh`)
```bash
./cleanup-manager.sh [command]
├─ status      (show task status)
├─ logs        (tail server logs)
├─ test-failed (test cleanup logic)
├─ test-orphan (test orphan detection)
├─ check-redis (verify Redis)
└─ stats       (show statistics)
```

## 🔄 Component Dependencies

```
index.ts
├─ Imports: cleanup-scheduler.ts
├─ Imports: BullMQ (Worker)
├─ Uses: FastifyInstance (supabase, s3, uploadQueue)
└─ Registers: Graceful shutdown handlers

cleanup-scheduler.ts
├─ Imports: FastifyInstance type
├─ Uses: fastify.supabase (database queries)
├─ Uses: fastify.s3 (R2 storage deletion)
└─ Exports: cleanupTasks, executeCleanupTask

cleanup-rpc.sql
├─ Creates: find_orphan_media() function
├─ Creates: idx_property_media_cleanup index
└─ Dependencies: property_media table

cleanup-manager.sh
├─ Uses: npx tsx (execute test scripts)
├─ Uses: redis-cli (check Redis)
├─ Uses: docker (if available, check logs)
└─ Dependencies: SUPABASE_URL, SUPABASE_SERVICE_KEY
```

## 🔐 Permission Model

```
Server Process (with service role key)
    ↓
Has full Supabase access (service role)
    ├─ Can query all tables
    ├─ Can call RPC functions
    └─ Can delete records
    ↓
Can delete from R2 storage (with credentials)
    ├─ Using: R2_ACCESS_KEY_ID
    ├─ Using: R2_SECRET_ACCESS_KEY
    └─ Limited to specific bucket
    ↓
Can schedule jobs in Redis
    ├─ Using: REDIS_URL
    └─ Worker reads from Redis
```

## 📈 Scalability Considerations

### Current Limits
- **Per-item processing**: Serialized (one at a time)
- **Batch size**: Configurable (see CLEANUP_SETUP.md)
- **Redis queue**: No limit (scales with Redis)
- **R2 API calls**: Within Cloudflare limits

### For High Volume
1. **Parallel workers**: Add more Worker instances
2. **Batch processing**: Process items in groups
3. **Distributed workers**: Run on multiple servers
4. **Sharded queues**: One queue per cleanup type

## 🚦 Health Checks

### What to Monitor

```
┌─ Redis Connection
│  └─ redis-cli ping
│
├─ Worker Status
│  └─ KEYS "bull:cleanup-*" in Redis
│
├─ Job Execution
│  └─ Look for "🧹 Starting cleanup" in logs
│
├─ Failed Media Count
│  └─ SELECT COUNT(*) FROM property_media WHERE status='failed'
│
├─ Storage Freed
│  └─ Track total file_size_bytes deleted
│
└─ Error Rate
   └─ Watch for "❌ Failed to cleanup" in logs
```

## 🎯 Performance Optimization

### Database
- ✅ Indexes on (processing_status, marked_for_cleanup, marked_for_cleanup_at)
- ✅ RPC function filters at database level
- ✅ Efficient LEFT JOIN for orphan detection

### Storage
- ✅ Parallel R2 deletions (could be added)
- ✅ Error handling doesn't block cleanup
- ✅ One deletion per item (memory efficient)

### Redis
- ✅ BullMQ handles scheduling
- ✅ Workers are long-lived (no startup overhead)
- ✅ Cron-based scheduling (reliable)

## 🔍 Debugging

### Enable Verbose Logging
```bash
# In index.ts, increase log level
fastify.log.level = 'debug'

# Or via environment
LOG_LEVEL=debug npm run dev
```

### Check Component Status
```bash
# Redis
redis-cli KEYS "bull:cleanup-*"
redis-cli ZRANGE bull:cleanup-failed-media:waiting 0 -1

# Database
SELECT * FROM pg_stat_user_indexes WHERE relname = 'property_media';

# Supabase logs
# Check dashboard → Logs → Postgres logs
```

## 🚀 Deployment Strategy

### Pre-deployment
1. Apply cleanup-rpc.sql in staging
2. Deploy code to staging
3. Test with ./cleanup-manager.sh commands
4. Verify in logs

### Production
1. Schedule deployment for off-peak time
2. Apply cleanup-rpc.sql migration
3. Deploy code changes
4. Monitor logs for first cleanup run
5. Verify storage freed in database

### Rollback
1. Stop cleanup workers: Comment in index.ts
2. Redeploy
3. Keep cleanup-rpc.sql (has no breaking changes)

## 📋 Summary Table

| Component | Type | Purpose | Status |
|-----------|------|---------|--------|
| cleanup-scheduler.ts | Module | Task definitions | ✅ Complete |
| cleanup-rpc.sql | Database | RPC + Indexes | ✅ Ready |
| index.ts (modified) | Server | Worker init | ✅ Integrated |
| cleanup-manager.sh | Script | Management | ✅ Ready |
| CLEANUP_SETUP.md | Doc | Setup guide | ✅ Complete |
| CLEANUP_SYSTEM.md | Doc | System docs | ✅ Complete |
| CLEANUP_IMPLEMENTATION.md | Doc | This guide | ✅ Complete |

---

**The cleanup system is fully documented and ready for production deployment!** 🚀
