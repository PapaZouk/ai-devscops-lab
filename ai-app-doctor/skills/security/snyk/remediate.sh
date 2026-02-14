#!/bin/bash
set -euo pipefail

# $TARGET_DIR should be set by the MCP server environment
cd "$TARGET_DIR"

echo "[$(date)] Starting Snyk remediation..." >> snyk_actions.log

# `snyk fix` is not universally available (CLI/org feature flags).
# Keep it opt-in so local/CI flows remain deterministic.
if [ "${ENABLE_SNYK_FIX:-false}" = "true" ]; then
  if snyk fix --force --yes 2>&1 | tee -a snyk_actions.log; then
    echo "[$(date)] Snyk auto-fix completed." >> snyk_actions.log
    exit 0
  fi
  echo "[$(date)] snyk fix failed, applying remediation.upgrade fallback." >> snyk_actions.log
else
  echo "[$(date)] skipping snyk fix (ENABLE_SNYK_FIX is not true), applying remediation.upgrade fallback." >> snyk_actions.log
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for fallback remediation but was not found." | tee -a snyk_actions.log
  exit 1
fi

if [ ! -f "snyk_report.json" ]; then
  echo "snyk_report.json not found; cannot compute upgrade fallback." | tee -a snyk_actions.log
  exit 1
fi

mapfile -t upgrades < <(jq -r '.remediation.upgrade | to_entries[]? | .value.upgradeTo' snyk_report.json | sort -u)

if [ "${#upgrades[@]}" -eq 0 ]; then
  echo "No remediation.upgrade entries found; nothing to apply." | tee -a snyk_actions.log
  exit 0
fi

for dep in "${upgrades[@]}"; do
  echo "Applying upgrade: $dep" | tee -a snyk_actions.log
  npm install --save-exact "$dep" 2>&1 | tee -a snyk_actions.log
done

# Ensure lockfile and tree are consistent after manifest updates.
npm install 2>&1 | tee -a snyk_actions.log

echo "[$(date)] Snyk remediation attempted via fallback upgrades." >> snyk_actions.log
