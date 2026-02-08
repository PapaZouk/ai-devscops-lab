import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentConfig } from "./types/agentConfig.js";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { getLogger } from "@logtape/logtape";
import OpenAI from "openai";
import chalk from "chalk";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = getLogger("orchestrator");

export async function startOrchestrator(
    config: AgentConfig,
    targetPath: string,
    userPrompt: string
) {
    const transport = new StdioClientTransport({
        command: "node",
        args: [path.resolve(__dirname, "../../mcp-security-server/build/index.js")],
        env: {
            ...process.env,
            CWD: targetPath
        }
    });

    const mcpClient = new Client(
        { name: "orchestrator", version: "1.0.0" },
        { capabilities: {} }
    );

    await mcpClient.connect(transport);
    logger.info(chalk.green.bold("🚀 Orchestrator connected to MCP server"));

    const lmStudio = new OpenAI({
        baseURL: process.env.LM_BASE_URL || "http://localhost:1234/v1",
        apiKey: process.env.LM_API_KEY || "lm-studio"
    });

    const { tools } = await mcpClient.listTools();
    const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = tools
        .filter((tool) => !config.allowedTools || config.allowedTools.includes(tool.name))
        .map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.inputSchema
            }
        }));

    let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: userPrompt },
    ];

    let stepCount = 0;
    const maxAttempts = config.maxSteps || 15;

    while (stepCount < maxAttempts) {
        stepCount++;
        logger.info(chalk.blue(`\n🧠 Thinking (Step ${stepCount}/${maxAttempts})`));

        let response;
        try {
            response = await lmStudio.chat.completions.create({
                model: config.model || "qwen/qwen3-4b:free",
                messages,
                tools: toolDefinitions,
                tool_choice: "auto",
            });
        } catch (error: any) {
            logger.error(chalk.red(`❌ Error during LM request: ${error.message}`));
            return { success: false, report: `Error during LM request: ${error.message}` };
        }

        const aiMessage = response.choices[0].message;
        logger.info(chalk.gray(`💬 LM Message received`));
        const content = aiMessage.content || "";

        if (content) logger.info(chalk.gray(`💬 LM Response: ${content}`));

        if (content.includes("TERMINATE_SESSION")) {
            logger.info(chalk.green.bold("✅ Task completed successfully!"));
            await mcpClient.close();
            await transport.close();
            return {
                success: true,
                report: content.replace("TERMINATE_SESSION", "").trim()
            }
        }

        messages.push(aiMessage);

        if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
            logger.info(chalk.yellow.bold("🏁 Ending session. No tool calls made by the LM."));
            return { success: true, report: content }
        }

        for (const toolCall of aiMessage.tool_calls) {
            if (toolCall.type === "function" && toolCall.function) {
                logger.info(chalk.cyan(`🛠️  Executing tool: ${toolCall.function.name}`));

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

                    logger.info(chalk.gray(`📤 Tool Output send back to AI`));
                } catch (error: any) {
                    logger.error(chalk.red(`❌ Error executing tool: ${error.message}`));
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: `Error: ${error.message}`,
                    });
                }
            } else {
                logger.warn(chalk.yellow(`⚠️  Unsupported tool call type: ${toolCall.type}`));
            }
        }
    }

    logger.warn(chalk.red.bold("\n⚠️  Maximum steps reached. Ending session."));
    await mcpClient.close();
    await transport.close();
    return {
        success: false,
        report: "Maximum steps reached without task completion."
    }
}