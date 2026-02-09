#!/bin/bash
# ai-security-orchestrator/skills/jwt-fix/verify.sh

TARGET_FILE=$1

# 1. Absolute path check (handle relative vs absolute better)
if [ ! -f "$TARGET_FILE" ]; then
  # Try relative to CWD if first try fails
  if [ ! -f "./$TARGET_FILE" ]; then
    echo "ERROR: Target file $TARGET_FILE not found."
    exit 1
  fi
fi

# 2. Check for fallback patterns (Simplified for better grep compatibility)
# This looks for ?? ' or || " to catch hardcoded fallbacks
if grep -qE "(\?\?|\|\|)\s*['\"]" "$TARGET_FILE"; then
  echo "FAILURE: Fallback secret detected (hardcoded string fallback found)."
  exit 1
fi

# 3. Check for algorithm enforcement
if ! grep -q "HS256" "$TARGET_FILE"; then
  echo "FAILURE: HS256 algorithm not found in file."
  exit 1
fi

echo "SUCCESS: JWT Security standards met."
exit 0