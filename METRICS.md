# Viewora Backend - Metrics & Alerting

This document describes the metrics system and how to use it for monitoring, alerting, and debugging.

## Overview

The backend exports **Prometheus metrics** via the `/metrics` endpoint. These metrics track:

- Job processing (success, failure, retries)
- Queue health (depth, active jobs, failed jobs)
- Processing performance (latency, throughput)
- System health (CPU, memory)

---

## Core Metrics

### Counters (cumulative, never decrease)

#### `viewora_jobs_processed_total{outcome="success|failed"}`
- **Type**: Counter
- **Description**: Total jobs completed
- **Labels**: `outcome` = "success" or "failed"
- **Example Query**: 
  ```
  rate(viewora_jobs_processed_total[5m])  # Jobs per second
  ```
- **Use Case**: Track overall throughput

#### `viewora_jobs_retried_total`
- **Type**: Counter
- **Description**: Total number of job retries
- **Example Query**: 
  ```
  rate(viewora_jobs_retried_total[5m])  # Retries per second
  ```
- **Use Case**: Detect transient failure patterns

#### `viewora_jobs_dead_letter_total`
- **Type**: Counter
- **Description**: Jobs moved to dead-letter (permanent failures)
- **Example Query**:
  ```
  viewora_jobs_dead_letter_total  # Cumulative count
  ```
- **Use Case**: Alert when stuck jobs accumulate

#### `viewora_jobs_stalled_total`
- **Type**: Counter
- **Description**: Jobs that timed out / hung
- **Example Query**:
  ```
  rate(viewora_jobs_stalled_total[5m]) > 1  # More than 1/sec = alert
  ```
- **Use Case**: Detect hanging jobs early

### Gauges (can increase or decrease)

#### `viewora_queue_depth`
- **Type**: Gauge
- **Description**: Number of jobs waiting in queue
- **Example Query**:
  ```
  viewora_queue_depth > 500  # Alert if backlog exceeds 500
  ```
- **Use Case**: Detect queue backlog / overload

#### `viewora_active_jobs`
- **Type**: Gauge
- **Description**: Number of jobs currently being processed
- **Example Query**:
  ```
  viewora_active_jobs  # Should match WORKER_CONCURRENCY
  ```
- **Use Case**: Verify worker is processing

#### `viewora_failed_jobs`
- **Type**: Gauge
- **Description**: Number of failed jobs in dead-letter queue
- **Example Query**:
  ```
  viewora_failed_jobs > 10  # Alert if more than 10 stuck jobs
  ```
- **Use Case**: Monitor permanent failures

#### `viewora_error_rate_percent`
- **Type**: Gauge
- **Description**: Percentage of jobs that failed (calculated as: failed / (failed + waiting + active) * 100)
- **Example Query**:
  ```
  viewora_error_rate_percent > 5  # Alert if error rate > 5%
  ```
- **Use Case**: High-level health indicator

### Histograms (distribution of values)

#### `viewora_job_duration_ms_bucket`
- **Type**: Histogram
- **Description**: Job processing duration in milliseconds
- **Buckets**: 100ms, 500ms, 1s, 2s, 5s, 10s
- **Example Queries**:
  ```
  # Median processing time
  histogram_quantile(0.5, rate(viewora_job_duration_ms_bucket[5m]))
  
  # 95th percentile (p95)
  histogram_quantile(0.95, rate(viewora_job_duration_ms_bucket[5m]))
  
  # 99th percentile (p99)
  histogram_quantile(0.99, rate(viewora_job_duration_ms_bucket[5m]))
  ```
- **Use Case**: Monitor latency, SLA compliance

#### `viewora_upload_file_size_bytes_bucket`
- **Type**: Histogram
- **Description**: Upload file size distribution
- **Buckets**: 100KB, 500KB, 1MB, 5MB, 10MB, 50MB
- **Example Query**:
  ```
  # Median upload size
  histogram_quantile(0.5, rate(viewora_upload_file_size_bytes_bucket[1h]))
  ```
- **Use Case**: Understand workload characteristics

---

## Pre-defined Alerts

See `prometheus-rules.yml` for complete alert definitions.

### CRITICAL Alerts (page on-call)

| Alert | Condition | Action |
|-------|-----------|--------|
| **UploadErrorRateCritical** | Error rate > 10% | Investigate processing failures immediately |
| **QueueBacklogCritical** | Queue depth > 500 | Scale workers up or find bottleneck |
| **JobProcessingTimeout** | >1 job/sec timing out | Restart worker or increase timeout |
| **CleanupJobNotRunIn24h** | No failed-media cleanup completion for 24h | Check scheduler/worker/Redis immediately |

### WARNING Alerts (investigate)

| Alert | Condition | Action |
|-------|-----------|--------|
| **UploadErrorRateElevated** | Error rate > 5% for 5+ min | Monitor and investigate |
| **QueueBacklogElevated** | Queue depth > 200 for 10+ min | Consider scaling workers |
| **SlowMediaProcessing** | p95 latency > 5s | Monitor for SLA violations |
| **CleanupFailureRateElevated** | Cleanup failure rate > 5% in 24h | Investigate cleanup task failures |
| **CleanupSuccessRateSlaBreach** | Cleanup success rate < 99% in 24h | SLA breach, immediate triage |

---

## Cleanup Health Dashboard Endpoint

Admin endpoint for at-a-glance cleanup visibility:

- `GET /admin/cleanup-health`
- Auth: `Authorization: Bearer $ADMIN_SECRET`

Returns per-task snapshot fields including:

- last run timestamp
- total runs
- success/failure counts
- deleted items
- average and last duration

Example:

```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  http://localhost:3000/admin/cleanup-health
```

---

## Alert Delivery Smoke Test

Use the included synthetic alert script to verify routing into Alertmanager and downstream channels:

```bash
ALERTMANAGER_URL=http://localhost:9093 ./scripts/alert-smoke-test.sh
```

What it does:

- posts synthetic warning + critical cleanup alerts
- queries active alerts in Alertmanager
- checks current Alertmanager status/config

### INFO Alerts (trend monitoring)

| Alert | Condition | Action |
|-------|-----------|--------|
| **DeadLetterQueueGrowing** | >10 jobs to dead-letter in 1h | Review failed jobs via API |
| **WorkerInactive** | 0 jobs in 5 min | Check if worker crashed |

---

## Dashboard Queries (for Grafana)

### Real-Time Job Processing

```sql
# Jobs processed per second (success)
rate(viewora_jobs_processed_total{outcome="success"}[1m])

# Jobs failed per second
rate(viewora_jobs_processed_total{outcome="failed"}[1m])

# Success rate percentage
(rate(viewora_jobs_processed_total{outcome="success"}[5m]) /
 (rate(viewora_jobs_processed_total{outcome="success"}[5m]) +
  rate(viewora_jobs_processed_total{outcome="failed"}[5m]))) * 100
```

### Queue Health

```sql
# Queue depth over time
viewora_queue_depth

# Active vs waiting jobs
sum(viewora_active_jobs) vs sum(viewora_queue_depth)

# Failed jobs accumulation
viewora_failed_jobs
```

### Processing Performance

```sql
# p50 (median) latency
histogram_quantile(0.5, rate(viewora_job_duration_ms_bucket[5m]))

# p95 latency (SLA target: <5s)
histogram_quantile(0.95, rate(viewora_job_duration_ms_bucket[5m]))

# p99 latency (SLA target: <10s)
histogram_quantile(0.99, rate(viewora_job_duration_ms_bucket[5m]))

# Max observed latency
max(viewora_job_duration_ms)
```

### Reliability Metrics

```sql
# Total retries per hour
rate(viewora_jobs_retried_total[1h])

# Stalled jobs per minute
rate(viewora_jobs_stalled_total[1m])

# Permanent failures per hour
rate(viewora_jobs_dead_letter_total[1h])
```

---

## Grafana Configuration

### Quick Start

1. **Add Prometheus Data Source**:
   - Navigate to: Grafana → Data Sources → New
   - Name: `Prometheus`
   - URL: `http://prometheus:9090`
   - Click "Save & Test"

2. **Import Dashboard** (coming soon):
   - Create dashboard manually using queries above, OR
   - Import pre-built JSON dashboard (place in `./grafana-dashboard.json`)

3. **Set Up Alerts**:
   - Each panel can have alert rules
   - Recommended: p95 latency should alert if > 5s
   - Recommended: error rate should alert if > 5%

---

## Troubleshooting

### "No data in metrics"

1. Verify worker is running: `curl http://localhost:3000/metrics | grep viewora_`
2. Check if Prometheus is scraping: `curl http://prometheus:9090/api/v1/targets`
3. Verify URL is correct in `prometheus.yml`

### "Queue depth stuck high"

1. Check if worker is running: `systemctl status viewora-worker`
2. Check worker logs for errors: `journalctl -u viewora-worker -f`
3. Check active jobs: `curl -H "Authorization: Bearer $ADMIN_SECRET" http://localhost:3000/admin/queue-stats`

### "High error rate"

1. List failed jobs: `curl -H "Authorization: Bearer $ADMIN_SECRET" http://localhost:3000/admin/failed-jobs`
2. Inspect failure reasons
3. Fix upstream issue (e.g., image too large, network timeout)
4. Manually retry when ready: `curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" http://localhost:3000/admin/retry-job/JOB_ID`

### "Processing is slow"

1. Check p95 latency: `histogram_quantile(0.95, rate(viewora_job_duration_ms_bucket[5m]))`
2. Check active jobs: `curl http://localhost:3000/admin/queue-stats`
3. If active < WORKER_CONCURRENCY: worker may be waiting on I/O
4. If active == WORKER_CONCURRENCY: increase concurrency: `WORKER_CONCURRENCY=10`

---

## Integration with Alerting System

### AlertManager Setup

Prometheus sends alerts to AlertManager, which routes them to:
- **Slack**: Team notifications
- **PagerDuty**: On-call escalation
- **Email**: Critical incidents
- **Webhooks**: Custom integrations

Example AlertManager config:

```yaml
route:
  receiver: 'default'
  group_by: ['alertname', 'component']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h

receivers:
  - name: 'default'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#viewora-alerts'
        title: 'Viewora Backend Alert'
        text: '{{ .GroupLabels.alertname }}: {{ .GroupLabels.component }}'
```

---

## SLA & Performance Targets

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Success Rate | > 98% | < 95% (error rate > 5%) |
| p95 Latency | < 5s | > 5s |
| p99 Latency | < 10s | > 10s |
| Queue Depth | < 50 jobs | > 500 jobs |
| Worker Concurrency | 5 | Scale up if queue > 200 |

---

## Maintenance

### Daily
- Check Grafana dashboard for trends
- Review alert logs in AlertManager
- Note any sustained warning alerts

### Weekly
- Review dead-letter queue growth
- Check error rate trends
- Plan capacity based on queue metrics

### Monthly
- Archive old metrics (Prometheus default: 15 days)
- Update alert thresholds if workload changes
- Review slowest jobs (p99 histogram)
