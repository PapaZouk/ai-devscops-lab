# Skill: Snyk Vulnerability Remediation

## Domain Rule: Immutable Security Baseline
- **Requirement:** All fixes must be verified against the original `$REPORT_PATH`.
- **Constraint:** Do not ignore or "patch-out" vulnerabilities to achieve a green build. If a fix is blocked by breaking changes, it must be documented in `snyk_actions.log` rather than bypassed.
- **Behavior:** Prioritize "Critical" and "High" severity issues. If a "Low" severity fix introduces a "High" severity risk (e.g., dependency conflicts), you must roll back immediately.

## Domain Rule: Dependency Integrity
- **Standard:** Maintain lockfile consistency. After any manual manifest change, the remediation script must be re-run to sync the environment.
- **Verification:** Post-remediation, the lockfile must be checked for consistency with the manifest.
- **Lockfile Handling:** Never edit or write lockfiles manually. Regenerate via package-manager commands only.
- **Tool Safety (Mandatory):** Do NOT call `read_file` or `write_file` for any lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).
- **Allowed Flow:** If remediation requires dependency changes, edit only `package.json` and run `run_command` with npm/pnpm/yarn to regenerate lockfiles.

## Execution Protocol
1. **Analyze:** Parse the Snyk report provided in the task context to identify specific targets.
2. **Patch:** Apply the remediation logic.
   - **Tool Call:** Use `run_command` with the following parameters:
     - `path`: `skills/security/snyk/remediate.sh`
3. **Verify:** You MUST validate the fix using the verification script.
   - **Tool Call:** Use `run_command` with the following parameters:
     - `path`: `skills/security/snyk/verify.sh`
   - **Validation:** Compare the `uniqueCount` in `snyk_verify_results.json` against the initial report.
4. **Troubleshooting:** If the script fails to resolve a vulnerability, do not loop. Perform a manual version bump in the manifest and re-execute the **Verify** step.
   - **Manifest-only edit:** Use `write_file` on `package.json` only.
   - **Regenerate dependencies:** Use `run_command(command="npm", args=["install"])` (or equivalent package manager command).
   - **Forbidden:** Never inspect or patch lockfiles with `read_file`/`write_file`.

## PROTOCOL: CLINICAL DELIVERY
- Before finishing, you MUST consult `skills/git/delivery/instructions.md`.
- **Treatment Validation:** Always use `git_diff` to review dependency changes. Ensure no unrelated source files were modified.
- **PR Management:** When creating the PR via `gh`, you MUST use the `--fill` or `--title/--body` flags to avoid interactive prompts.
- **Example:** `run_command(command="gh pr create --title 'Security: Fix Snyk Vulnerabilities' --body 'Automated remediation of high-severity CVEs.'")`

## Definition of Done
- All targeted vulnerabilities from the Snyk report are resolved.
- `verify.sh` confirms a reduction in vulnerability count.
- `snyk_actions.log` contains a timestamped record of the "treatment."
- No absolute paths or prohibited shell flags (`-lc`, `$(pwd)`) were used.
- No lockfile was read or written via `read_file`/`write_file`.
