#!/usr/bin/env bash

# Cleanup System Monitoring & Management Script
# Helps manage and monitor the Viewora cleanup jobs

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print with color
print_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
  echo -e "${RED}❌ $1${NC}"
}

print_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# Show usage
show_usage() {
  cat <<EOF
Viewora Cleanup Management Script

Usage: ./cleanup-manager.sh [command] [options]

Commands:
  status              Show cleanup task status
  logs                Tail cleanup task logs
  test-failed         Manually trigger failed media cleanup
  test-orphan         Manually trigger orphan media cleanup
  check-redis         Check Redis connection and queue status
  stats               Show cleanup statistics
  help                Show this help message

Examples:
  ./cleanup-manager.sh status
  ./cleanup-manager.sh logs
  ./cleanup-manager.sh test-failed
  ./cleanup-manager.sh check-redis

Environment:
  REDIS_URL           Redis connection URL (default: redis://localhost:6379)
  SUPABASE_URL        Supabase project URL
  SUPABASE_SERVICE_KEY Supabase service role key

EOF
}

# Check Redis connection
check_redis() {
  print_info "Checking Redis connection..."

  local redis_url="${REDIS_URL:-redis://localhost:6379}"

  # Parse Redis URL
  if [[ $redis_url =~ redis://(.+):(.+) ]]; then
    local host_port="${BASH_REMATCH[1]}"
    local password="${BASH_REMATCH[2]}"

    if [[ $host_port == *:* ]]; then
      local host="${host_port%:*}"
      local port="${host_port##*:}"
    else
      local host="localhost"
      local port="6379"
    fi
  else
    local host="localhost"
    local port="6379"
  fi

  if redis-cli -h "$host" -p "$port" ping &>/dev/null; then
    print_success "Redis connection successful"

    # Show queue status
    print_info "Getting queue status..."
    redis-cli -h "$host" -p "$port" KEYS "bull:cleanup-*" 2>/dev/null || true
  else
    print_error "Cannot connect to Redis at $host:$port"
    exit 1
  fi
}

# Show task status
show_status() {
  print_info "Cleanup task status:"
  echo ""
  echo "Failed Media Cleanup:"
  echo "  Schedule: 0 2 * * * (2 AM UTC daily)"
  echo "  Last run: (check logs below)"
  echo ""
  echo "Orphan Media Cleanup:"
  echo "  Schedule: 0 3 * * 0 (3 AM UTC every Sunday)"
  echo "  Last run: (check logs below)"
  echo ""

  if command -v docker &>/dev/null; then
    print_info "Checking Docker container logs..."
    docker logs --tail=20 "$(docker ps -q --filter='ancestor=viewora-backend' 2>/dev/null | head -1)" 2>/dev/null | grep -E "🧹|✅|❌" || true
  else
    print_info "For server logs, check your deployment platform (Railway, Vercel, etc.)"
  fi
}

# Tail logs
tail_logs() {
  print_info "Tailing cleanup task logs..."
  echo ""

  if command -v docker &>/dev/null; then
    print_info "Docker logs:"
    docker logs -f "$(docker ps -q --filter='ancestor=viewora-backend' 2>/dev/null | head -1)" 2>/dev/null | grep -E "🧹|✅|❌|cleanup" || true
  else
    print_warning "Docker not available. Check your deployment platform logs:"
    echo "  - Railway: https://railway.app/project-logs"
    echo "  - Vercel: https://vercel.com/dashboard/deployments"
  fi
}

# Test failed media cleanup
test_failed_cleanup() {
  print_info "Testing failed media cleanup..."
  echo ""

  if ! command -v npx &>/dev/null; then
    print_error "npx not available. Please run this from the backend directory."
    exit 1
  fi

  # Create a test script
  cat > /tmp/test-cleanup.ts <<'EOF'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

const { data: failedMedia, error } = await supabase
  .from('property_media')
  .select('id, processing_status, marked_for_cleanup, marked_for_cleanup_at, file_size_bytes')
  .eq('processing_status', 'failed')
  .eq('marked_for_cleanup', true)
  .lt('marked_for_cleanup_at', sevenDaysAgo)

if (error) {
  console.error('Error:', error)
  process.exit(1)
}

if (!failedMedia || failedMedia.length === 0) {
  console.log('✅ No failed media to clean up')
  process.exit(0)
}

console.log(`📊 Found ${failedMedia.length} media items marked for cleanup:`)
console.log('')

failedMedia.forEach((item, i) => {
  console.log(`${i + 1}. ID: ${item.id}`)
  console.log(`   Marked: ${item.marked_for_cleanup_at}`)
  console.log(`   Size: ${(item.file_size_bytes / 1024 / 1024).toFixed(2)} MB`)
})

console.log('')
const totalSize = failedMedia.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0)
console.log(`📈 Total size to reclaim: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`)
EOF

  npx tsx /tmp/test-cleanup.ts
  rm /tmp/test-cleanup.ts
}

# Test orphan cleanup
test_orphan_cleanup() {
  print_info "Testing orphan media cleanup..."
  echo ""

  if ! command -v npx &>/dev/null; then
    print_error "npx not available. Please run this from the backend directory."
    exit 1
  fi

  # Create a test script
  cat > /tmp/test-orphan.ts <<'EOF'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

try {
  const { data: orphanMedia, error } = await supabase.rpc('find_orphan_media')

  if (error) {
    console.error('Error:', error)
    console.log('')
    console.log('💡 Tip: Make sure the find_orphan_media() RPC function is created.')
    console.log('Run: npx tsx src/utils/cleanup-scheduler.ts to initialize.')
    process.exit(1)
  }

  if (!orphanMedia || orphanMedia.length === 0) {
    console.log('✅ No orphan media found')
    process.exit(0)
  }

  console.log(`📊 Found ${orphanMedia.length} orphan media items:`)
  console.log('')

  orphanMedia.forEach((item, i) => {
    console.log(`${i + 1}. ID: ${item.id}`)
    console.log(`   Key: ${item.storage_key || 'N/A'}`)
    console.log(`   Size: ${(item.file_size_bytes / 1024 / 1024).toFixed(2)} MB`)
  })

  console.log('')
  const totalSize = orphanMedia.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0)
  console.log(`📈 Total size to reclaim: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`)
} catch (err: any) {
  print_error(`Test failed: ${err.message}`)
  console.log('')
  console.log('Please check:')
  console.log('1. SUPABASE_URL and SUPABASE_SERVICE_KEY are set')
  console.log('2. The find_orphan_media() RPC function exists')
}
EOF

  npx tsx /tmp/test-orphan.ts
  rm /tmp/test-orphan.ts
}

# Show cleanup statistics
show_stats() {
  print_info "Fetching cleanup statistics..."
  echo ""

  if ! command -v npx &>/dev/null; then
    print_error "npx not available. Please run this from the backend directory."
    exit 1
  fi

  cat > /tmp/get-stats.ts <<'EOF'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

console.log('📊 Cleanup System Statistics\n')

// Failed media stats
const { data: failedStats } = await supabase
  .from('property_media')
  .select('processing_status, file_size_bytes')
  .eq('processing_status', 'failed')

const failedCount = failedStats?.length || 0
const failedSize = failedStats?.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0) || 0

console.log(`Failed Media:`)
console.log(`  Count: ${failedCount}`)
console.log(`  Total Size: ${(failedSize / 1024 / 1024 / 1024).toFixed(2)} GB`)
console.log('')

// Media marked for cleanup
const { data: markedStats } = await supabase
  .from('property_media')
  .select('file_size_bytes')
  .eq('marked_for_cleanup', true)

const markedCount = markedStats?.length || 0
const markedSize = markedStats?.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0) || 0

console.log(`Marked for Cleanup:`)
console.log(`  Count: ${markedCount}`)
console.log(`  Total Size: ${(markedSize / 1024 / 1024 / 1024).toFixed(2)} GB`)
console.log('')

// Total media
const { data: totalStats } = await supabase
  .from('property_media')
  .select('file_size_bytes', { count: 'exact' })

const totalCount = totalStats?.length || 0
const totalSize = totalStats?.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0) || 0

console.log(`Total Media in System:`)
console.log(`  Count: ${totalCount}`)
console.log(`  Total Size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`)
console.log('')

// Failed by property
console.log(`Failed Media by Property:`)
const { data: byProperty } = await supabase
  .from('property_media')
  .select('property_id, file_size_bytes')
  .eq('processing_status', 'failed')

const grouped = (byProperty || []).reduce((acc: any, m) => {
  acc[m.property_id] = (acc[m.property_id] || 0) + (m.file_size_bytes || 0)
  return acc
}, {})

Object.entries(grouped)
  .sort(([, sizeA]: any, [, sizeB]: any) => sizeB - sizeA)
  .slice(0, 5)
  .forEach(([propId, size]: any) => {
    console.log(`  ${propId}: ${(size / 1024 / 1024).toFixed(2)} MB`)
  })
EOF

  npx tsx /tmp/get-stats.ts
  rm /tmp/get-stats.ts
}

# Main command handler
command="${1:-help}"

case "$command" in
  status)
    show_status
    ;;
  logs)
    tail_logs
    ;;
  test-failed)
    test_failed_cleanup
    ;;
  test-orphan)
    test_orphan_cleanup
    ;;
  check-redis)
    check_redis
    ;;
  stats)
    show_stats
    ;;
  help)
    show_usage
    ;;
  *)
    print_error "Unknown command: $command"
    echo ""
    show_usage
    exit 1
    ;;
esac
