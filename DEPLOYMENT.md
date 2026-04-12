# Deployment Configuration

## Local Development

### Prerequisites
- Node.js 22+
- Redis (local or via Docker)

### Setup

```bash
# Install dependencies
npm install

# Create .env file with required variables (see .env.example)
cp .env.example .env

# Start Redis locally (using Docker)
docker run -d -p 6379:6379 redis:latest

# Start API server
npm run dev

# In another terminal, start the worker
npm run worker
```

## Production Deployment (Railway.app)

### Architecture
- **API Service**: Node.js app running `node dist/index.js`
- **Worker Service**: Node.js app running `node dist/worker.js`
- **Redis**: Managed Redis instance (required by both services)

### Step 1: Push to GitHub
```bash
git push origin main
```

### Step 2: Create API Service
1. Go to [Railway.app Dashboard](https://railway.app)
2. Create new project
3. Connect GitHub repository
4. Select `viewora-backend` folder
5. Wait for automatic deployment (uses railway.json)

### Step 3: Add Redis Service
1. In Railway project, click "Add Service"
2. Select "Database" → "Redis"
3. Click "Add"
4. Railway automatically provides `REDIS_URL` environment variable

### Step 4: Add Worker Service
1. In Railway project, click "Add Service"
2. Select "GitHub Repo"
3. Connect same GitHub repo
4. In service settings:
   - **Name**: `worker`
   - **Root Directory**: `viewora-backend`
   - **Build Command**: `npm run build`
   - **Start Command**: `node dist/worker.js`
5. Ensure these environment variables are linked:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `REDIS_URL` (auto-linked from Redis service)
6. Click "Deploy"

### Step 5: Link Environment Variables
Both API and Worker services need access to:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `SUPABASE_JWT_SECRET` (API only)
- `R2_ACCOUNT_ID` (API only)
- `R2_BUCKET_NAME` (API only)
- `R2_ACCESS_KEY_ID` (API only)
- `R2_SECRET_ACCESS_KEY` (API only)
- `REDIS_URL` (both, auto-linked)

### Verification
1. Call API health check: `curl https://your-api.railway.app/health`
2. Check API logs for successful Redis connection
3. Check Worker logs for "Upload worker started, listening for jobs..."

### Monitoring
- Check worker logs regularly:
  - "Media processing job completed successfully" = ✅ good
  - "Media processing job failed" with retry count = processing failures (will auto-retry)
  - "Media processing moved to dead-letter" = stuck jobs (needs investigation)

### Scaling
- To increase worker concurrency, modify `src/queues/upload.queue.ts` → `concurrency: 5` (default)
- To change retry strategy, modify `backoff` config in same file
- Consider upgrading Redis tier if queue depth grows >1000 jobs

## Troubleshooting

### "Redis connection refused"
- Verify `REDIS_URL` environment variable is set in Railway
- Check Redis service is running (`railway logs redis`)

### "Upload jobs never process"
- Check worker service is deployed and running (`railway logs worker`)
- Verify worker has `REDIS_URL` environment variable
- Check for "listening for jobs" in worker logs

### "Upload API returns 500"
- Check if `uploadQueue` is undefined in fastify
- Verify `process.env.REDIS_URL` is available at startup
- API gracefully falls back to sync processing if queue unavailable

### Dead-letter Queue Buildup
- Jobs move to dead-letter after 5 failed attempts (exponential backoff)
- Check job details in BullMQ dashboard (if using enterprise)
- Manually inspect failed job records in `property_media` table where `processing_status = 'failed'`

## CI/CD

The `npm run build && npm test` passes automatically on every commit.

To manually test before deploying:
```bash
npm run build
npm test
```
