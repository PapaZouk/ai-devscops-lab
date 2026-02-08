import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";
import { AgentConfig } from "./types/agentConfig.js";
import { configDotenv } from "dotenv";

configDotenv();

const logger = getLogger("orchestrator");

export async function startOrchestrator(config: AgentConfig, targetPath: string, userPrompt: string) {
    logger.info(chalk.blue.bold("🚀 Starting Orchestrator..."));

    const serverPath = path.resolve(process.cwd(), "../mcp-security-server/build/index.js");
    const absoluteSkillsPath = path.resolve(process.cwd(), "skills");

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            CWD: targetPath,
            SKILLS_PATH: absoluteSkillsPath
        }
    });

    const client = new Client({ name: "safety-orchestrator", version: "1.0.0" }, { capabilities: {} });

    try {
        await client.connect(transport);
        logger.info(chalk.green("🟢 MCP Server online."));
    } catch (err: any) {
        logger.error(chalk.red(`❌ Connection Failed: ${err.message}`));
        return { success: false, report: "MCP Connection Failed" };
    }

    const { tools } = await client.listTools();
    logger.info(chalk.green.bold(`🛠 Discovered ${tools.length} tools.`));

    const BASE_URL = process.env.LM_BASE_URL || "http://localhost:1234/v1";
    const API_KEY = process.env.LM_API_KEY || "lm-studio";

    logger.info(chalk.blue(`🔗 Connecting to LM at ${BASE_URL} with model ${config.model}`));

    const openai = new OpenAI({
        baseURL: BASE_URL,
        apiKey: API_KEY
    });

    const runtimeSystemPrompt = `${config.systemPrompt}
    
    RUNTIME CONTEXT:
    - Your Skills Library is located at: ${absoluteSkillsPath}
    - The Target Project you are fixing is at: ${targetPath}

    When accessing skills, you MUST use the absolute path: ${absoluteSkillsPath}
    `;

    let messages: any[] = [
        { role: "system", content: runtimeSystemPrompt },
        { role: "user", content: config.generatePrompt ? config.generatePrompt(targetPath, userPrompt) : userPrompt }
    ];

    let turns = 0;
    const maxTurns = 15;

    while (turns < maxTurns) {
        turns++;

        const response = await openai.chat.completions.create({
            model: config.model,
            messages,
            tools: tools.map(t => ({ type: "function", function: t }))
        });

        const message = response.choices[0].message;
        messages.push(message);

        logger.info(chalk.gray(`💬 Turn ${turns}: AI Message Received (role: ${message.role})`));

        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const call of message.tool_calls) {
                if (call.type === "function" && call.function) {
                    let parsedArgs: any = {};
                    try {
                        parsedArgs = JSON.parse(call.function.arguments || "{}");
                    } catch (e) {
                        parsedArgs = { raw: call.function.arguments };
                    }

                    logger.info(chalk.yellow(`🔧 Tool: ${call.function.name}`));
                    console.log(chalk.gray(JSON.stringify(parsedArgs, null, 2)));

                    try {
                        const result = await client.callTool({
                            name: call.function.name,
                            arguments: parsedArgs
                        });

                        messages.push({
                            role: "tool",
                            tool_call_id: call.id,
                            content: JSON.stringify(result.content)
                        });
                    } catch (toolErr: any) {
                        logger.error(chalk.red(`❌ Tool Error: ${toolErr.message}`));
                        messages.push({
                            role: "tool",
                            tool_call_id: call.id,
                            content: JSON.stringify({ error: toolErr.message })
                        });
                    }
                }
            }
            continue;
        }

        if (message.content) {
            console.log(chalk.cyan(`\n🤖 AI Response:\n${message.content}`));
            break;
        }

        break;
    }

    if (turns >= maxTurns) {
        logger.warn(chalk.red("⚠️ Maximum turns reached."));
    }

    await client.close();
    await transport.close();
    return { success: true, report: "Workflow completed." };
}