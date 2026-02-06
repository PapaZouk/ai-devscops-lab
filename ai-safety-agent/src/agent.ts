import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Configuration & Paths
const TARGET_APP_PATH = path.resolve(__dirname, "../../vulnerable-api-app");
const MAX_STEPS = 15; // Increased slightly for breathing room, but prompt is now stricter

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
  console.log(`🔌 Connected to MCP Tool Server`);
  console.log(`🎯 Target App Root: ${TARGET_APP_PATH}`);

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
    console.log(`\n🧠 AI is thinking (Step ${stepCount}/${MAX_STEPS})...`);

    const response = await lmStudio.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages,
      tools: toolDefinitions,
      tool_choice: "auto"
    });

    const aiMessage = response.choices[0].message;
    const content = aiMessage.content || "";

    // 1. PRIORITY CHECK: Did the AI signal termination?
    if (content.includes("TERMINATE_SESSION")) {
      console.log("\n✅ Task successfully completed.");
      console.log("\n🏁 Final Report:", content.replace("TERMINATE_SESSION", "").trim());
      return; // Exit the function entirely
    }

    messages.push(aiMessage);

    // 2. If no tools were called, treat as a completion even without the keyword
    if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
      console.log("\n🏁 Final Report:", content || "No further actions taken.");
      return;
    }

    // 3. EXECUTION: Process tool calls
    for (const toolCall of aiMessage.tool_calls) {
      console.log(`🛠️  Executing: ${toolCall.function.name}`);

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

        console.log(`📡 Data sent back to AI (${toolOutput.length} chars)`);
      } catch (err: any) {
        console.error(`❌ Tool Execution Error: ${err.message}`);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: ${err.message}`,
        });
      }
    }
  }

  console.log("\n⚠️  Maximum steps reached. Safety shutdown initiated.");
}

runAgent().catch(err => {
  console.error("❌ Agent failed:", err);
  process.exit(1);
});