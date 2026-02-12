#!/bin/bash
set -e

# $TARGET_DIR should be set by the MCP server environment
cd "$TARGET_DIR"

echo "[$(date)] Starting Snyk remediation..." >> snyk_actions.log

# Attempt to apply auto-fixes
# --force allows it to upgrade dependencies even if they are out of range
snyk fix --force --yes | tee -a snyk_actions.log

echo "[$(date)] Snyk remediation attempted." >> snyk_actions.log