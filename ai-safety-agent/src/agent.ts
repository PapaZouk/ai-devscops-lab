import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";

/**
 * PURE MCP AGENT
 * Logic-free: Only bridges the LLM to the MCP Server.
 */

// 1. Setup the Brain (LM Studio)
const lmStudio = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "not-needed",
});

// 2. Setup the "Hands" (The MCP Server Connection)
// We call the server as a separate process via stdio
const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve(__dirname, "../../mcp-security-server/build/index.js")],
});

const mcpClient = new Client(
  { name: "ai-safety-agent", version: "1.0.0" },
  { capabilities: {} }
);

async function runAgent() {
  // Connect to the tool server
  await mcpClient.connect(transport);
  console.log("🔌 Connected to MCP Tool Server");

  // Dynamically get tools from the server (No hardcoding!)
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
      content: "You are an Autonomous Security Architect. Analyze code and fix vulnerabilities using tools."
    },
    {
      role: "user",
      content: "Vulnerability: Hardcoded JWT secret. Target: src/services/authService.ts"
    }
  ];

  while (true) {
    console.log("\n🧠 Thinking...");
    const response = await lmStudio.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages,
      tools: toolDefinitions,
    });

    const aiMessage = response.choices[0].message;
    messages.push(aiMessage);

    if (!aiMessage.tool_calls) {
      console.log("\n🏁 Final Response:", aiMessage.content);
      break;
    }

    for (const toolCall of aiMessage.tool_calls) {
      console.log(`🛠️  Executing Tool: ${toolCall.function.name}`);

      // CALL THE ACTUAL MCP SERVER
      const result = await mcpClient.callTool({
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      });

      // Pass the REAL data back to the AI
      const content = result.content[0].type === "text" ? result.content[0].text : "Success";

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: content,
      });

      console.log(`📡 Feedback sent to AI (${content.length} chars)`);
    }
  }
}

runAgent().catch(console.error);