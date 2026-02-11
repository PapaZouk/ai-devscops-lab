# Skill: Clinical Delivery (Git & Pull Request)

## Domain Rule: Branch Isolation
- **Requirement:** Every "treatment" (change) must reside in its own feature branch.
- **Naming Convention:** `doctor/[category]-[short-description]` (e.g., `doctor/refactor-auth-logic`).

## Status: Mandatory Completion Skill 
- This skill MUST be executed immediately after any successful code verification. You are not "Done" until the Recovery/Submission protocol is attempted.

## Domain Rule: Professional Documentation
- **Requirement:** Explain the "Clinical Intent" of the change.
- **Structure for MR Description:**
    1. **Context:** What state was the code in? (Diagnosis)
    2. **Changes:** What specific logic was modified/added? (Treatment)
    3. **Evidence:** Proof that the change works (e.g., verify.sh results).
    4. **Keep it concise:** 3-5 high-impact bullet points.

## Execution Protocol
1. **Pre-Flight (one time only):** Run `skills/git/delivery/verify.sh` once.
2. **Initialize:** Create and switch to a new feature branch `doctor/[category]-[description]`.
3. **Set commit identity (repo-local):** configure `user.name` and `user.email` before committing.
4. **Execute:** Stage and commit the existing code changes.
5. **Submit:** Push the branch and create the MR.
6. **Do not loop:** After pre-flight succeeds, never run `skills/git/delivery/verify.sh` again in the same session.

### Command Format Requirement
- Use `run_command(command, args)` for `git` and `gh` executables.
- Do NOT send `git` or `gh` via `path`.

### Example Calls
- `run_command(command: "git", args: ["checkout", "-b", "doctor/secure-secret-management"])`
- `run_command(command: "git", args: ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"])`
- `run_command(command: "git", args: ["config", "user.name", "github-actions[bot]"])`
- `run_command(command: "git", args: ["add", "src/services/authService.ts"])`
- `run_command(command: "git", args: ["commit", "-m", "Fix hardcoded secret in authService"])`
- `run_command(command: "git", args: ["push", "-u", "origin", "HEAD"])`
- `run_command(command: "gh", args: ["pr", "create", "--title", "Fix hardcoded secret in authService", "--body", "..."])`

## Recovery Protocol (Self-Correction)
- **If 'origin' is missing:** Run `git remote -v` to diagnose. If no remote exists, ask the user for the target URL or attempt to use the current directory context to re-add origin.
- **If 'gh' auth fails:** Verify if `GITHUB_TOKEN` is present in the environment. If not, inform the user that the PR cannot be opened automatically.
- **If commit fails with identity unknown:** configure local `git config user.email` and `git config user.name`, then retry commit once.
- **If `gh pr create` says push first:** run `git push -u origin HEAD`, then retry `gh pr create` once.
- **If branch already exists:** If the push fails because the branch exists on remote, use `git push -f` only if you are certain your local changes are the latest "Doctor's" version.

## Definition of Done
The agent provides the link to the opened Merge Request and a summary of the filed report.
