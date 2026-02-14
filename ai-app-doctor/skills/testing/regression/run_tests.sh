#!/bin/bash
set -e
cd "$TARGET_DIR"

echo "[$(date)] Starting Regression Suite..." >> testing_audit.log

# Detect the test runner (modular for npm/yarn)
if [ -f "package.json" ]; then
    echo "Running npm tests..." >> testing_audit.log
    npm test -- --watchAll=false --reporter=json > test_results.json 2>> testing_audit.log
fi

echo "[$(date)] Regression Suite Completed." >> testing_audit.log