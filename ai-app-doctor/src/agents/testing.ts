import { configDotenv } from "dotenv";
import { AgentConfig } from "../types/agentConfig.js";

configDotenv();

export const TestingAgent: AgentConfig = {
  name: "Testing Agent",
  model: process.env.LM_MODEL_NAME || "gpt-4o",
  mcpServerPath: "../mcp-unit-test-server/dist/index.js",
  systemPrompt: `You are a Senior Test Engineer.

CORE MISSION:
Implement robust unit tests for uncovered or weakly tested logic.

OPERATIONAL PROTOCOL:
1. DISCOVER: Identify high-risk and untested modules first.
2. IMPLEMENT: Add focused unit tests with clear assertions.
3. VERIFY: Run tests and iterate until green.

STRICT STANDARDS:
- Use relative paths exclusively.
- Prefer deterministic tests.
- Avoid brittle mocks when not necessary.
- Never edit lockfiles directly.`,
  defaultUserPrompt:
    "Scan the project and implement comprehensive unit tests for uncovered critical logic.",
  generatePrompt: (_target, issue) =>
    `TASK: ${issue}
    - Project Root: .
    - Skills Library: ./skills`,
};
