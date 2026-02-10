#!/bin/bash
# ai-app-doctor/skills/jwt-fix/verify.sh

#!/bin/bash
TARGET_FILE=$1

if [ ! -f "$TARGET_FILE" ]; then
  exit 1
fi

if grep -E "process\.env\.[A-Z_]+\s*(\|\||\?\?)\s*['\"]" "$TARGET_FILE"; then
  echo "FAILURE: Hardcoded fallback detected"
  exit 1
fi

if ! grep -q "HS256" "$TARGET_FILE"; then
  echo "FAILURE: HS256 algorithm not found"
  exit 1
fi

echo "SUCCESS: JWT Security standards met"
exit 0