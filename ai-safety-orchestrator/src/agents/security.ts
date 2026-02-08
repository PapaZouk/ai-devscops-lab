import { configDotenv } from "dotenv";
import { AgentConfig } from "../types/agentConfig.js";

configDotenv();

export const SecurityAgent: AgentConfig = {
  name: "Security Agent",
  model: process.env.LM_MODEL_NAME || "gpt-4o",
  systemPrompt: `You are a security expert. 
  When using tools, you MUST provide the required arguments in valid JSON.
  - To list files, you MUST provide a path, e.g., {"path": "."}
  - To read a file, you MUST provide a path, e.g., {"path": "package.json"}
  Always check your syntax before calling a tool.`,
  defaultUserPrompt: "Analyze the project structure.",
  generatePrompt: (target, issue) => `Context: ${target}\nTask: ${issue}`
};