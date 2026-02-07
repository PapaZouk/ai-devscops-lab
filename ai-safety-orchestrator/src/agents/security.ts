import { AgentConfig } from "../types/agentConfig.js";

export const SecurityAgent: AgentConfig = {
  name: "Security Architect",
  model: "openai/gpt-oss-20b",
  systemPrompt: "...",
  defaultUserPrompt: "Perform a general security scan.",
  generatePrompt: (file, issue) => `Fix the following issue: ${issue} in the file: ${file}`
};