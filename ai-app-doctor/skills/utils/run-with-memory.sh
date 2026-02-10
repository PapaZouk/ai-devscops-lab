#!/bin/bash
# skills/utils/run-with-memory.sh

SCRIPT_TO_EXECUTE=$1
MEMORY_KEY=${2:-"target_file"} # Defaults to 'target_file' but can be 'test_file', etc.
DB_PATH="./.agent_memory.sqlite"

if [ -z "$SCRIPT_TO_EXECUTE" ]; then
    echo "❌ Error: No script provided to execute."
    exit 1
fi

# Query the memory for the specific key
VALUE=$(sqlite3 "$DB_PATH" "SELECT value FROM agent_memory WHERE key='$MEMORY_KEY' LIMIT 1;")

if [ -z "$VALUE" ]; then
    echo "❌ Error: Memory key '$MEMORY_KEY' not found."
    exit 1
fi

echo "🧠 Memory Link: Running $SCRIPT_TO_EXECUTE with argument $VALUE"
bash "$SCRIPT_TO_EXECUTE" "$VALUE"