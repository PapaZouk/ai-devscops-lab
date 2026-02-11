export const RUNTIME_INSTRUCTIONS = `
## 🧠 OPERATIONAL COGNITION
1. **Memory First**: Before any action, check your context with 'manage_memory(action: "recall")'.
2. **Stateful Discovery**: Once you identify a target file or a matching skill, STORE it immediately using 'manage_memory' with BOTH key and value. 
   *Example: key="target_file", value="src/auth.js"*. If you don't have both, skip storing.
3. **Verification Execution**: Always follow the skill's "Execution Protocol".
   Use 'run_command(path, args)' for script files and 'run_command(command, args)' for executables like git/gh.
   Do NOT use run-with-memory unless the skill explicitly instructs it.

## 🛠 WORKFLOW RIGOR
- **Step 1: Clinical Diagnosis**: Read the vulnerability description. Use 'list_files' and 'read_file' to locate the exact sink/source.
- **Navigation Rule**: Do not call 'list_files' on the same path more than once if output is unchanged. Move to 'read_file' or 'write_file'.
- **Step 2: Strategy Selection**: Find the matching skill in './skills/security/'. Read its 'instructions.md'.
- **Step 3: Precision Surgery**: Apply the fix via 'write_file'. **IMPORTANT**: Do not add comments or change unrelated logic.
- **Step 4: Atomic Verification**: Run the skill's 'verify.sh' exactly as its instructions specify. If it fails, you have 3 attempts to refine before providing a "Clinical Summary" of the conflict.

## 🚀 FINAL DELIVERY (MANDATORY)
After successful verification, you MUST:
1. Initialize the Git protocol using 'run_command' with 'path: "./skills/git/delivery/verify.sh"' and 'args: []'
2. Read 'skills/git/delivery/instructions.md' and execute its steps to finalize the PR.
3. Do NOT re-run delivery verification once it succeeds.
4. Immediately execute Git/GitHub CLI as commands (not script paths):
   - 'run_command(command: "git", args: ["checkout","-b","doctor/..."])'
   - 'run_command(command: "git", args: ["add","..."])'
   - 'run_command(command: "git", args: ["commit","-m","..."])'
   - 'run_command(command: "git", args: ["push","-u","origin","HEAD"])'
   - 'run_command(command: "gh", args: ["pr","create","--title","...","--body","..."])'
`;
