import { configDotenv } from "dotenv";
import { AgentConfig } from "../types/agentConfig.js";

configDotenv();

export const SecurityAgent: AgentConfig = {
  name: "Security Architect",
  model: process.env.LM_MODEL_NAME || "qwen/qwen3-4b:free",
  systemPrompt: "...",
  defaultUserPrompt: "Perform a general security scan.",
  generatePrompt: (file, issue) => `Fix the following issue: ${issue} in the file: ${file}`
};