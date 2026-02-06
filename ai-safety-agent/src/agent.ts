import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

// Fix for ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const lmStudio = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio",
});

// Setup the Transport to talk to your MCP server
const transport = new StdioClientTransport({
  command: "node",
  // Ensure this points to your COMPILED mcp-security-server index.js
  args: [path.resolve(__dirname, "../../mcp-security-server/build/index.js")],
});

const mcpClient = new Client(
  { name: "security-agent", version: "1.0.0" },
  { capabilities: {} }
);

async function runAgent() {
  await mcpClient.connect(transport);
  console.log("🔌 Connected to MCP Tool Server");

  // 1. DYNAMICALLY get tools (No hardcoding logic!)
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
      content: "You are an Autonomous Security Architect. Use tools to analyze and fix code. You MUST provide a final summary when done."
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

    // If AI is done and just talking
    if (!aiMessage.tool_calls) {
      console.log("\n🏁 Final Report:", aiMessage.content);
      break;
    }

    // 2. DISPATCHER (Logic-free)
    for (const toolCall of aiMessage.tool_calls) {
      console.log(`🛠️  Executing: ${toolCall.function.name}(${toolCall.function.arguments})`);

      try {
        // We call the tool via the MCP client bridge
        const result = await mcpClient.callTool({
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        });

        // 3. FEEDBACK (The most important part)
        // We take the actual text from the tool and give it to the AI
        const toolOutput = result.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput || "Success",
        });

        console.log(`📡 Data sent to AI (${toolOutput.length} characters)`);
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