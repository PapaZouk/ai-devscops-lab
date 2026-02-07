import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";

await setupLogger();
const logger = getLogger(["security-agent"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_APP_PATH = path.resolve(__dirname, "../../vulnerable-api-app");
const MAX_STEPS = 15;

const lmStudio = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio",
});

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve(__dirname, "../../mcp-security-server/build/index.js")],
  env: {
    ...process.env,
    CWD: TARGET_APP_PATH,
    NODE_PATH: process.env.NODE_PATH || ""
  },
});

const mcpClient = new Client(
  { name: "security-agent", version: "1.0.0" },
  { capabilities: {} }
);

async function runAgent() {
  await mcpClient.connect(transport);
  logger.info(`🔌 Connected to MCP Tool Server`);
  logger.info(`🎯 Target App Root: ${TARGET_APP_PATH}`);

  const { tools } = await mcpClient.listTools();
  const toolDefinitions = tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are an Autonomous Security Architect.
        Working Directory: ${TARGET_APP_PATH}.

        MISSION:
        Fix the specific vulnerability requested. Do not perform excessive directory exploration.
        
        STRICT RULES:
        1. Once the fix is confirmed (SUCCESS from secure_write), immediately summarize and stop.
        2. You MUST end your final response with the keyword: TERMINATE_SESSION.
        3. Do not suggest further improvements once the primary vulnerability is fixed.`
    },
    {
      role: "user",
      content: "Vulnerability: Hardcoded JWT secret. Target: src/services/authService.ts"
    }
  ];

  let stepCount = 0;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    logger.info(`\n🧠 AI is thinking (Step ${stepCount}/${MAX_STEPS})...`);

    const response = await lmStudio.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages,
      tools: toolDefinitions,
      tool_choice: "auto"
    });

    const aiMessage = response.choices[0].message;
    const content = aiMessage.content || "";

    if (content.includes("TERMINATE_SESSION")) {
      logger.info("\n✅ Task successfully completed.");
      logger.info(`\n🏁 Final Report: ${content.replace("TERMINATE_SESSION", "").trim()}`);
      return;
    }

    messages.push(aiMessage);

    if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
      logger.info(`\n🏁 Final Report: ${content || "No further actions taken."}`);
      return;
    }

    for (const toolCall of aiMessage.tool_calls) {
      if (toolCall.type === "function" && toolCall.function) {
        logger.info(`🛠️  Executing: ${toolCall.function.name}`);

        logger.info(`🛠️  Executing: ${toolCall.function.name}`);

        try {
          const result = await mcpClient.callTool({
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments),
          }) as { content: { type: string; text?: string }[] };

          const toolOutput = result.content
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('\n');

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolOutput || "Success",
          });

          logger.info(`📡 Data sent back to AI (${toolOutput.length} chars)`);
        } catch (err: any) {
          logger.error(`❌ Tool Execution Error: ${err.message}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${err.message}`,
          });
        }
      } else {
        logger.warn(`⚠️  Unrecognized tool call format: ${JSON.stringify(toolCall)}`);
      }
    }
  }

  logger.warn("\n⚠️  Maximum steps reached. Safety shutdown initiated.");
}

runAgent().catch(err => {
  logger.error("❌ Agent failed:", err);
  process.exit(1);
});