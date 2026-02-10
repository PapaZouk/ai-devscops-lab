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
1. **Initialize:** Create and switch to a new feature branch `doctor/[category]-[description]`.
2. **Execute:** Apply the necessary code changes.
3. **Verify:** Run the diagnostic scripts (e.g., `verify.sh`).
4. **Submit:** Push the branch and create the MR.
   - **Command:** `git push -u origin HEAD && gh pr create --title "[Title]" --body "[Synthesized Description]"`

## Recovery Protocol (Self-Correction)
- **If 'origin' is missing:** Run `git remote -v` to diagnose. If no remote exists, ask the user for the target URL or attempt to use the current directory context to re-add origin.
- **If 'gh' auth fails:** Verify if `GITHUB_TOKEN` is present in the environment. If not, inform the user that the PR cannot be opened automatically.
- **If branch already exists:** If the push fails because the branch exists on remote, use `git push -f` only if you are certain your local changes are the latest "Doctor's" version.

## Definition of Done
The agent provides the link to the opened Merge Request and a summary of the filed report.