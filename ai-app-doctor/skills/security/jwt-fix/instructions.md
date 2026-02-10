# Skill: Secure Secret Management

## Domain Rule: Fail-Fast Secrets
Applications must never start with an insecure state. 
- **Requirement:** Secrets must be sourced from the environment.
- **Constraint:** Hardcoded defaults or "fallbacks" are strictly prohibited.
- **Behavior:** The application must terminate or throw an exception if the required environment variable is missing or empty.

## Domain Rule: Cryptographic Enforcement
- **Standard:** Symmetric token signing (JWT) must use a minimum algorithm of HS256.
- **Verification:** Both signing and verification logic must explicitly declare the algorithm to prevent "algorithm switching" attacks.

## Execution Protocol
1. **Patch:** Implement the "Fail-Fast" rule in the target source code.
2. **Verify:** You MUST validate the fix using the provided verification script.
   - **Tool Call:** Use `run_command` with the following parameters:
     - `path`: The relative path to this skill's `verify.sh`.
     - `args`: A list containing the relative path to the patched file.
   - **Constraints:** - DO NOT use `bash -lc`, `$(pwd)`, or nested shell strings.
      - DO NOT attempt to change file permissions (chmod).
   - **Troubleshooting:** If the command fails, examine `STDERR`. If the error is "File not found", use `list_files` to confirm the relative path of both the script and the target file before retrying.

## PROTOCOL: CLINICAL DELIVERY
- Before finishing, you MUST consult 'skills/git/delivery/instructions.md'.
- Always use `git_diff` to double-check your "treatment" (patch).
- When creating a PR, you MUST use the `--fill` or `--title/--body` flags to avoid interactive prompts which will hang the tool.
- Example: `run_command(command="gh pr create --title '...' --body '...'")`

## Definition of Done
- The "Fail-Fast" logic is implemented (no fallbacks).
- The verification script returns a success status.
- No absolute paths or environment-specific shell hacks were used.