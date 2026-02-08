#!/bin/bash
# ai-security-orchestrator/skills/jwt-fix/verify.sh

TARGET_FILE=$1

# Check if file exists
if [ ! -f "$TARGET_FILE" ]; then
  echo "ERROR: Target file $TARGET_FILE not found."
  exit 1
fi

# 1. Check for fallback patterns
if grep -E "(\?\?|\|\|)\s*['\"]" "$TARGET_FILE"; then
  echo "FAILURE: Fallback secret detected (patterns like || 'secret' found)."
  exit 1
fi

# 2. Check for algorithm enforcement (HS256)
if ! grep -q "HS256" "$TARGET_FILE"; then
  echo "FAILURE: Mandatory algorithm (HS256) not explicitly defined."
  exit 1
fi

echo "SUCCESS: JWT Security standards met."
exit 0