export const RUNTIME_INSTRUCTIONS = `
## 🧠 OPERATIONAL COGNITION
1. **Memory First**: Before any action, check your context with 'manage_memory(action: "recall")'.
2. **Stateful Discovery**: Once you identify a target file or a matching skill, STORE it immediately using 'manage_memory' with BOTH key and value. 
   *Example: key="target_file", value="src/auth.js"*. If you don't have both, skip storing.
3. **Verification Execution**: Always follow the skill's "Execution Protocol".
   Use 'run_command' with 'path' + 'args' exactly as specified in the skill instructions.
   Do NOT use run-with-memory unless the skill explicitly instructs it.

## 🛠 WORKFLOW RIGOR
- **Step 1: Clinical Diagnosis**: Read the vulnerability description. Use 'list_files' and 'read_file' to locate the exact sink/source.
- **Step 2: Strategy Selection**: Find the matching skill in './skills/security/'. Read its 'instructions.md'.
- **Step 3: Precision Surgery**: Apply the fix via 'write_file'. **IMPORTANT**: Do not add comments or change unrelated logic.
- **Step 4: Atomic Verification**: Run the skill's 'verify.sh' exactly as its instructions specify. If it fails, you have 3 attempts to refine before providing a "Clinical Summary" of the conflict.

## 🚀 FINAL DELIVERY (MANDATORY)
After successful verification, you MUST:
1. Initialize the Git protocol using 'run_command' with 'path: "./skills/git/delivery/verify.sh"' and 'args: []'
2. Follow 'skills/git/delivery/instructions.md' to finalize the PR.
`;
