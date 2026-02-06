import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Define the absolute path to your target application
const TARGET_APP_PATH = path.resolve(__dirname, "../../vulnerable-api-app");

const lmStudio = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio",
});

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve(__dirname, "../../mcp-security-server/build/index.js")],
  // 2. Inject the target path into the MCP server's environment
  env: {
    ...process.env,
    CWD: TARGET_APP_PATH,
    // We also set the actual process working directory for the spawned server
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
      // 3. Explicitly tell the AI where it is working to prevent confusion
      content: `You are an Autonomous Security Architect. 
      Your working directory is: ${TARGET_APP_PATH}.
      
      STRICT EXIT PROTOCOL:
      1. Your goal is ONLY to fix the specified vulnerability.
      2. As soon as you receive a "SUCCESS" from a tool and have no more critical changes, you MUST stop.
      3. Do not explore the directory further after a successful fix unless requested.
      4. End your final summary with: "TERMINATE_SESSION".`
    },
    {
      role: "user",
      content: "Vulnerability: Hardcoded JWT secret. Target: src/services/authService.ts"
    }
  ];

  while (true) {
    console.log("\n🧠 AI is thinking...");
    const response = await lmStudio.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages,
      tools: toolDefinitions,
      tool_choice: "auto"
    });

    const aiMessage = response.choices[0].message;
    messages.push(aiMessage);

    if (!aiMessage.tool_calls) {
      console.log("\n🏁 Final Report:", aiMessage.content);
      break;
    }

    for (const toolCall of aiMessage.tool_calls) {
      console.log(`🛠️  Executing: ${toolCall.function.name}`);

      try {
        const result = await mcpClient.callTool({
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        });

        const toolOutput = result.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput || "Success",
        });

        console.log(`📡 Data sent back to AI (${toolOutput.length} chars)`);
      } catch (err: any) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: ${err.message}`,
        });
      }
    }
  }
}

runAgent().catch(err => {
  console.error("❌ Agent failed:", err);
  process.exit(1);
});