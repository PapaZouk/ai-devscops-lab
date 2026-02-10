# Skill: State Management (Memory)

## Context
When working on complex repositories, you must maintain a "State of Truth" in the agent_memory table. This prevents redundant 'list_files' calls and avoids hardcoding.

## Mandatory Keys to Store
- `target_file`: The relative path to the file being patched.
- `selected_skill`: The path to the security skill being applied.
- `last_verify_error`: If a verify.sh fails, store the error here to analyze it.

## Procedure
1. **Discover**: Find the file.
2. **Memorize**: `manage_memory(action: "store", key: "target_file", value: "...")`
3. **Execute**: Use the stored path for all `read_file` and `write_file` calls.
4. **Finalize**: Recall the memory to ensure the `verify.sh` is run against the correct path.