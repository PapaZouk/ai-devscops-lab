#!/bin/bash
set -euo pipefail

cd "$TARGET_DIR"

echo "[$(date)] Verifying security status..." >> snyk_actions.log

# Run a fresh scan to see what remains
# We output to a verify file so we don't overwrite the original scan report
snyk test --json --severity-threshold=high > snyk_verify_results.json || true

# Compare against the initial report from the current run.
INITIAL_COUNT=$(jq '(.vulnerabilities // []) | length' snyk_report.json 2>/dev/null || echo 0)
REMAINING_COUNT=$(jq '(.vulnerabilities // []) | length' snyk_verify_results.json 2>/dev/null || echo 0)

echo "Verification complete. Initial high/critical: $INITIAL_COUNT, remaining: $REMAINING_COUNT" | tee -a snyk_actions.log

if [ "$REMAINING_COUNT" -lt "$INITIAL_COUNT" ]; then
  echo "✅ Verification passed: vulnerability count reduced." | tee -a snyk_actions.log
  exit 0
fi

echo "❌ Verification failed: high/critical vulnerability count did not decrease." | tee -a snyk_actions.log
exit 1
