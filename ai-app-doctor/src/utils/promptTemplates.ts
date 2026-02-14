const COMMON_RUNTIME_INSTRUCTIONS = `
## 🧠 OPERATIONAL COGNITION
1. **Memory First**: Before any action, check your context with 'manage_memory(action: "recall")'.
2. **Stateful Discovery**: Once you identify a target file or a matching skill, STORE it immediately using 'manage_memory' with BOTH key and value. 
   *Example: key="target_file", value="src/auth.js"*. If you don't have both, skip storing.
3. **Verification Execution**: Always follow the skill's "Execution Protocol".
   Use 'run_command(path, args)' for script files and 'run_command(command, args)' for executables like git/gh.
   Do NOT use run-with-memory unless the skill explicitly instructs it.

## 🛠 WORKFLOW RIGOR
- **Step 1: Clinical Diagnosis**: Read the vulnerability description. Use 'list_files' and 'read_file' to locate the exact sink/source.
- **Memory Use (Mandatory):** Call \`manage_memory(action: "recall")\` at the beginning and use seeded keys (\`snyk_summary\`, \`snyk_upgrade_plan\`, \`snyk_top_vulns\`) to plan remediation.
- **Navigation Rule**: Do not call 'list_files' on the same path more than once if output is unchanged. Move to 'read_file' or 'write_file'.
- **Snyk Fast Path**: If \`snyk_report.json\` exists and includes \`remediation.upgrade\`, read it once, then execute \`skills/security/snyk/remediate.sh\` followed by \`skills/security/snyk/verify.sh\`. Do not loop on repeated \`list_files\`/\`read_file\` calls for the same path.
- **Lockfile Rule**: Never use 'read_file' or 'write_file' on lockfiles (\`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`). Use \`run_command\` (\`npm install\`, \`npm update\`, \`npm audit fix\`) to regenerate them.
- **Step 2: Strategy Selection**: Find the matching skill in './skills/security/'. Read its 'instructions.md'.
- **Step 3: Precision Surgery**: Apply the fix via 'write_file'. **IMPORTANT**: Do not add comments or change unrelated logic.
- **Step 4: Atomic Verification**: Run the skill's 'verify.sh' exactly as its instructions specify. If it fails, you have 3 attempts to refine before providing a "Clinical Summary" of the conflict.
- **Completion Rule:** If \`verify.sh\` reports success, stop tool calls immediately and return the final "Clinical Summary". Do not re-open \`snyk_report.json\` or re-run directory listing.
`;

const DELIVERY_REQUIRED_INSTRUCTIONS = `
## 🚀 FINAL DELIVERY (MANDATORY)
After successful verification, you MUST:
1. Initialize the Git protocol using 'run_command' with 'path: "./skills/git/delivery/verify.sh"' and 'args: []'
2. Read 'skills/git/delivery/instructions.md' and execute its steps to finalize the PR.
3. Do NOT re-run delivery verification once it succeeds.
4. Execute Git/GitHub CLI in this strict order (no parallel calls, no reordering):
   - 'run_command(command: "git", args: ["checkout","-b","doctor/..."])'
   - 'run_command(command: "git", args: ["config","user.email","41898282+github-actions[bot]@users.noreply.github.com"])'
   - 'run_command(command: "git", args: ["config","user.name","github-actions[bot]"])'
   - 'run_command(command: "git", args: ["add","..."])'
   - 'run_command(command: "git", args: ["commit","-m","..."])'
   - 'run_command(command: "git", args: ["push","-u","origin","HEAD"])'
   - 'run_command(command: "gh", args: ["pr","create","--title","...","--body","..."])'
5. If any command fails, inspect STDERR, apply the recovery step from delivery instructions, and retry once.
`;

const LOCAL_COMPLETION_INSTRUCTIONS = `
## 🧪 LOCAL MODE COMPLETION (NO PR FLOW)
- Local mode is active. Do NOT run delivery pre-flight or any GitHub PR commands.
- After successful skill verification, stop tool use and provide a concise "Clinical Summary":
  - Patched file path
  - Verification command and result
  - Why PR delivery was skipped in local mode
`;

export function getRuntimeInstructions(options: { skipDelivery: boolean }): string {
  const completionInstructions = options.skipDelivery
    ? LOCAL_COMPLETION_INSTRUCTIONS
    : DELIVERY_REQUIRED_INSTRUCTIONS;

  return `${COMMON_RUNTIME_INSTRUCTIONS}\n\n${completionInstructions}`.trim();
}
