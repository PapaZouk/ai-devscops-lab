#!/bin/bash

echo "🔍 --- MCP PATH DEBUGGER ---"
echo "📅 Date: $(date)"
echo ""

echo "🌐 ENVIRONMENT CHECK:"
echo "PROJECT_ROOT: ${PROJECT_ROOT:-NOT SET}"
echo "SKILLS_PATH:  ${SKILLS_PATH:-NOT SET}"
echo ""

# Validation Logic
FAIL=0

if [ -d "$PROJECT_ROOT" ]; then
    echo "✅ PROJECT_ROOT exists."
else
    echo "❌ PROJECT_ROOT not found!"
    FAIL=1
fi

if [ -d "$SKILLS_PATH" ]; then
    echo "✅ SKILLS_PATH exists ($(ls $SKILLS_PATH | wc -l) skills found)."
else
    echo "❌ SKILLS_PATH not found!"
    FAIL=1
fi

if [ $FAIL -eq 1 ]; then
    echo ""
    echo "💥 FATAL: Environment misconfigured. Stopping workflow."
    exit 1
fi

echo ""
echo "📝 REPO VISIBILITY:"
ls -F