#!/usr/bin/env bash

set -euo pipefail

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://localhost:9093}"

NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END_UTC="$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+10M +%Y-%m-%dT%H:%M:%SZ)"

cat > /tmp/viewora-alert-smoke.json <<EOF
[
  {
    "labels": {
      "alertname": "CleanupFailureRateElevated",
      "severity": "warning",
      "component": "cleanup"
    },
    "annotations": {
      "description": "Synthetic smoke test alert for cleanup warning route",
      "action": "Validate warning delivery channel"
    },
    "startsAt": "${NOW_UTC}",
    "endsAt": "${END_UTC}"
  },
  {
    "labels": {
      "alertname": "CleanupJobNotRunIn24h",
      "severity": "critical",
      "component": "cleanup"
    },
    "annotations": {
      "description": "Synthetic smoke test alert for cleanup critical route",
      "action": "Validate critical delivery channel"
    },
    "startsAt": "${NOW_UTC}",
    "endsAt": "${END_UTC}"
  }
]
EOF

echo "[1/3] Posting synthetic alerts to ${ALERTMANAGER_URL}"
curl -sS -X POST "${ALERTMANAGER_URL}/api/v2/alerts" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/viewora-alert-smoke.json

echo "\n[2/3] Querying active cleanup alerts"
curl -sS "${ALERTMANAGER_URL}/api/v2/alerts?active=true&silenced=false&inhibited=false" | grep -E 'CleanupFailureRateElevated|CleanupJobNotRunIn24h|severity|component' || true

echo "\n[3/3] Verifying Alertmanager receiver status endpoint"
curl -sS "${ALERTMANAGER_URL}/api/v2/status" | grep -E 'versionInfo|configYAML|warning-slack|critical-slack' || true

echo "\nSmoke test completed. Verify Slack/email channels received both synthetic alerts."
