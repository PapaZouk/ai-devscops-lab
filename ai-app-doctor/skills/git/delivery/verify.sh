#!/bin/bash
# skills/git/delivery/verify.sh

echo "🔍 Running Pre-Flight Delivery Check..."

# 1. Check if Git is initialized
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "FAILURE: Not a git repository."
  exit 1
fi

# 2. Check for GitHub CLI
if ! command -v gh &> /dev/null; then
  echo "FAILURE: GitHub CLI (gh) not found in environment."
  exit 1
fi

# 3. Check for Auth Token
if [ -z "$GITHUB_TOKEN" ]; then
  # Try checking gh's own auth status as a fallback
  if ! gh auth status &> /dev/null; then
    echo "FAILURE: GITHUB_TOKEN is missing and 'gh' is not authenticated."
    exit 1
  fi
fi

echo "SUCCESS: Infrastructure ready for Clinical Delivery."
exit 0