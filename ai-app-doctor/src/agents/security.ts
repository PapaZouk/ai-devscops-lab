import { configDotenv } from "dotenv";
import { AgentConfig } from "../types/agentConfig.js";
import path from "node:path";

configDotenv();

export const SecurityAgent: AgentConfig = {
  name: "Security Agent",
  model: process.env.LM_MODEL_NAME || "gpt-4o",
  systemPrompt: `You are a Senior DevSecOps Engineer.
  
CORE MISSION:
Apply security fixes from the 'skills' library to the project code.

OPERATIONAL PROTOCOL:
1. DISCOVER: Use 'list_files' to locate the vulnerability in the project and the instructions in './skills'.
2. APPLY: Read the skill 'instructions.md' and the target file, then apply the fix using 'write_file'.
3. VERIFY: You MUST run the 'verify.sh' script from the skill folder to confirm the fix.

STRICT STANDARDS:
- Do not perform deep recursive scans unless a file cannot be found.
- Use relative paths exclusively.
- Parallel tool calls are preferred.`,

  // Changed to be goal-oriented, not tool-oriented
  defaultUserPrompt: "Identify the vulnerability, find the matching skill, and apply the fix.",

  generatePrompt: (target, issue) =>
    `TASK: Fix ${issue}
    - Project Root: .
    - Skills Library: ./skills`
};