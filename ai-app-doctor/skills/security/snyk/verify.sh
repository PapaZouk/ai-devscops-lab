#!/bin/bash
cd "$TARGET_DIR"

echo "[$(date)] Verifying security status..." >> snyk_actions.log

# Run a fresh scan to see what remains
# We output to a verify file so we don't overwrite the original scan report
snyk test --json > snyk_verify_results.json || true

# Check if high-severity issues still exist
VULN_COUNT=$(jq '.uniqueCount' snyk_verify_results.json)
echo "Verification complete. Remaining vulnerabilities: $VULN_COUNT" | tee -a snyk_actions.log