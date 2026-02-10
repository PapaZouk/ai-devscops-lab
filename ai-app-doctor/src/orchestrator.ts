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

configDotenv();

const logger = getLogger("orchestrator");


export async function startOrchestrator(config: AgentConfig, targetPath: string, userPrompt: string) {
    logger.info(chalk.blue.bold("🚀 Starting Orchestrator..."));

    const serverPath = path.resolve(process.cwd(), "../mcp-security-server/build/index.js");
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
            PROJECT_ROOT: path.resolve(targetPath),
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

    const runtimeSystemPrompt = `${config.systemPrompt}
    
    RUNTIME CONTEXT:
    - The Target Project root is: .
    - The Skills Library is: ./skills
    
    PATH RESOLUTION RULES:
    1. Always use relative paths from the current directory.
    2. To see the project, use list_files(path: ".")
    3. To see skills, use list_files(path: "./skills")
    4. To read a skill, use read_file and look for instructions.md in the skill folder.
    5. NEVER use absolute paths starting with /Users/ or /github/workspace.
    6. Parallel tool calls are encouraged to save turns.
    
    `;

    let messages: any[] = [
        { role: "system", content: runtimeSystemPrompt },
        { role: "user", content: config.generatePrompt ? config.generatePrompt(".", userPrompt) : userPrompt }
    ];

    let turns = 0;
    const maxTurns = 40;

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
            logger.info(chalk.cyan(`\n🤖 AI Final Response:\n${message.content}`));
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