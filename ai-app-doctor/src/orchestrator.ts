import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentConfig } from "./types/agentConfig.js";
import { configDotenv } from "dotenv";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai/build/src/instrumentation.js";
import { getRuntimeInstructions } from "./utils/promptTemplates.js";

configDotenv();

const openTelemetry = new NodeSDK({
    instrumentations: [new OpenAIInstrumentation()]
});
openTelemetry.start();

const logger = getLogger("orchestrator");

const MAX_HISTORY_TOOL_ARGS = 1500;
const MAX_HISTORY_TOOL_OUTPUT = 12000;

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function sanitizeToolArgsForLog(rawArgs: string): string {
    try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object") {
            const shallow = { ...parsed };
            for (const key of ["content", "code"]) {
                if (typeof shallow[key] === "string") {
                    shallow[key] = truncate(shallow[key], 500);
                }
            }
            return JSON.stringify(shallow, null, 2);
        }
        return truncate(rawArgs, 500);
    } catch {
        return truncate(rawArgs, 500);
    }
}

function sanitizeAssistantMessageForHistory(message: any) {
    if (!message?.tool_calls?.length) return message;

    return {
        ...message,
        tool_calls: message.tool_calls.map((call: any) => ({
            ...call,
            function: {
                ...call.function,
                arguments: truncate(call.function?.arguments || "{}", MAX_HISTORY_TOOL_ARGS)
            }
        }))
    };
}


export async function startOrchestrator(config: AgentConfig, targetPath: string, userPrompt: string) {
    logger.info(chalk.blue.bold("🚀 Starting Orchestrator..."));

    const serverPath = path.resolve(
        process.cwd(),
        config.mcpServerPath || "../mcp-security-server/build/index.js"
    );
    const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    const skillsPath = path.resolve(process.cwd(), "skills");

    logger.info(chalk.blue.bold(`📁 Skills Directory: ${skillsPath}`));
    try {
        const skillFiles = await fs.promises.readdir(skillsPath);
        logger.info(chalk.blue(`🔍 Found ${skillFiles.length} skills:`));
        skillFiles.forEach(file => logger.info(chalk.gray(`- ${file}`)));
    } catch (err) {
        logger.error(
            chalk.red(
                `❌ Failed to read skills directory: ${err instanceof Error ? err.message : String(err)
                }`
            )
        );
    }

    logger.info(chalk.blue(`📁 Target Project: ${targetPath}`));
    logger.info(chalk.blue(`📁 Skills Library: ${skillsPath}`));

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            PROJECT_ROOT:
                config.projectRootMode === "target"
                    ? path.resolve(targetPath)
                    : path.resolve(process.cwd()),
            CWD: targetPath,
            SKILLS_PATH: skillsPath
        }
    });

    const client = new Client({ name: "ai-app-doctor", version: "1.0.0" }, { capabilities: {} });

    try {
        await client.connect(transport);
        logger.info(chalk.green("🟢 MCP Server online."));
    } catch (err: any) {
        logger.error(chalk.red(`❌ Connection Failed: ${err.message}`));
        return { success: false, report: "MCP Connection Failed" };
    }

    const { tools } = await client.listTools();
    logger.info(chalk.green.bold(`🛠 Discovered ${tools.length} tools.`));

    const url = process.env.LM_BASE_URL || "http://localhost:1234/v1";
    const apiKey = process.env.LM_API_KEY || "lm-studio";
    logger.info(chalk.blue(`Using LLM at ${url} with model ${config.model}`));

    const openai = new OpenAI({
        baseURL: url,
        apiKey: apiKey
    });

    const skipDelivery = process.env.SKIP_DELIVERY === "true" || process.env.ACT === "true";

    if (skipDelivery) {
        logger.info(chalk.yellow("🧪 Local mode detected: PR delivery steps are disabled."));
    }

    const runtimeInstructions =
        config.runtimeInstructionsOverride ?? getRuntimeInstructions({ skipDelivery });

    const runtimeSystemPrompt = `
        ${config.systemPrompt}

        # RUNTIME CONTEXT
        - **Workbench**: Current Directory (.) is the project root.
        - **Tools**: Access to skills library via './skills'.

        ${runtimeInstructions}

        # SAFETY CONSTRAINTS
        - NEVER use absolute paths.
        - DO NOT remove existing logs.
        - If a fix fails 3 times, provide a diagnosis and STOP.
        `.trim();

    let messages: any[] = [
        { role: "system", content: runtimeSystemPrompt },
        { role: "user", content: config.generatePrompt ? config.generatePrompt(".", userPrompt) : userPrompt }
    ];

    let turns = 0;
    const maxTurns = 40;
    const toolRetryCounter = new Map<string, number>();
    let consecutiveEmptyAssistantTurns = 0;

    while (turns < maxTurns) {
        turns++;

        const response = await openai.chat.completions.create({
            model: config.model,
            messages,
            tools: tools.map(t => ({ type: "function", function: t })),
            tool_choice: "auto",
            temperature: 0,
        });

        const message = response.choices[0].message;
        const finishReason = response.choices[0].finish_reason;
        messages.push(sanitizeAssistantMessageForHistory(message));

        logger.info(chalk.gray(`💬 Turn ${turns}: AI Message Received (role: ${message.role})`));

        if (message.tool_calls && message.tool_calls.length > 0) {
            consecutiveEmptyAssistantTurns = 0;
            const toolOutputs: any[] = [];
            for (const call of message.tool_calls) {
                if (call.type !== 'function') {
                    toolOutputs.push({
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({ error: "Unsupported tool type" })
                    });
                    continue;
                }

                const toolName = call.function.name;
                const rawArgs = call.function.arguments || "{}";

                logger.info(chalk.yellow(`🔧 Tool: ${toolName}`));
                console.log(chalk.gray(sanitizeToolArgsForLog(rawArgs)));

                const toolKey = `${toolName}:${rawArgs}`;
                const count = (toolRetryCounter.get(toolKey) || 0) + 1;
                toolRetryCounter.set(toolKey, count);

                if (count > 3) {
                    logger.warn(chalk.red(`🛑 Circuit Breaker: ${toolName} reached max retries.`));
                    toolOutputs.push({
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({
                            error: "MAX_RETRIES_REACHED",
                            message: "This fix failed 3 times. Stop and report the conflict."
                        })
                    });
                    continue;
                }

                try {
                    const result = await client.callTool({
                        name: toolName,
                        arguments: JSON.parse(rawArgs)
                    });

                    let contentString = truncate(JSON.stringify(result.content), MAX_HISTORY_TOOL_OUTPUT);

                    const toolText = result.content
                        .map((c: any) => (typeof c.text === "string" ? c.text : ""))
                        .filter(Boolean)
                        .join("\n");

                    if (toolText) {
                        console.log(chalk.gray(`🧾 Tool Output (${toolName}):\n${toolText}`));
                    }

                    if (toolName === "list_files" && rawArgs.includes("skills/security/jwt-fix")) {
                        contentString += "\n\nSYSTEM NOTE: 'instructions.md' and 'verify.sh' are CONFIRMED present in this directory. If they did not appear in the list above, use 'read_file' directly.";
                    }

                    toolOutputs.push({
                        role: "tool",
                        tool_call_id: call.id,
                        content: contentString
                    });
                } catch (toolErr: any) {
                    logger.error(chalk.red(`❌ Tool Error: ${toolErr.message}`));
                    toolOutputs.push({
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({ error: toolErr.message })
                    });
                }
            }

            messages.push(...toolOutputs);
            continue;
        }

        if (message.content) {
            consecutiveEmptyAssistantTurns = 0;
            logger.info(chalk.cyan(`\n🤖 AI Final Response:\n${message.content}`));
            break;
        }

        consecutiveEmptyAssistantTurns += 1;
        logger.warn(
            chalk.yellow(
                `⚠️ Empty assistant turn ${consecutiveEmptyAssistantTurns} (finish_reason=${finishReason ?? "unknown"}).`
            )
        );

        if (consecutiveEmptyAssistantTurns >= 3) {
            logger.error(
                chalk.red(
                    "❌ Assistant returned no tool calls and no content for 3 consecutive turns. Stopping to avoid a silent loop."
                )
            );
            break;
        }
    }

    if (turns >= maxTurns) {
        logger.warn(chalk.red("⚠️ Maximum turns reached."));
    }

    await client.close();
    await transport.close();
    return { success: true, report: "Workflow completed." };
}
