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

configDotenv();

const openTelemetry = new NodeSDK({
    instrumentations: [new OpenAIInstrumentation()]
});
openTelemetry.start();

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
    - Target Project: .
    - Skills Library: ./skills
    
    NAVIGATION LOGIC:
    1. **Persistence of Knowledge**: If you successfully read a file (e.g., instructions.md) in a previous turn, it exists. Do not conclude a file is "missing" simply because a subsequent 'list_files' call with limited depth does not show it.
    2. **Direct Access**: If you know a file's likely path, use 'read_file' directly rather than scanning for it. 
    3. **Exhaustive Discovery**: Before reporting a skill as "incomplete," you must attempt to read './skills/security/[skill-name]/instructions.md' directly.

    PATH RESOLUTION RULES:
    1. Always use relative paths from the current directory (.).
    2. To see the project, use list_files(path: ".")
    3. To see skills, use list_files(path: "./skills")
    4. NEVER use absolute paths (e.g., /Users/... or /github/...).
    5. Parallel tool calls are encouraged to save turns.
    
    ## MANDATORY FINAL STEP: Clinical Delivery
    Once a fix is verified (verify.sh passes), you MUST:
    1. **Read** 'skills/git/delivery/instructions.md'.
    2. **Verify** delivery readiness by running 'skills/git/delivery/verify.sh'.
    3. If verification fails, reflect on the error logs, refine the patch, and re-verify. Do not loop the same fix more than 3 times.
    `;

    let messages: any[] = [
        { role: "system", content: runtimeSystemPrompt },
        { role: "user", content: config.generatePrompt ? config.generatePrompt(".", userPrompt) : userPrompt }
    ];

    let turns = 0;
    const maxTurns = 40;
    const toolRetryCounter = new Map<string, number>();

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
            const toolOutputs = await Promise.all(message.tool_calls.map(async (call) => {
                // TYPE GUARD: satisfy compiler and narrow type to access .function
                if (call.type !== 'function') {
                    return {
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({ error: "Unsupported tool type" })
                    };
                }

                const toolName = call.function.name;
                const rawArgs = call.function.arguments || "{}";

                // 1. Log Tool Call (Brings back the yellow tool logs)
                logger.info(chalk.yellow(`🔧 Tool: ${toolName}`));
                try {
                    const parsedArgs = JSON.parse(rawArgs);
                    console.log(chalk.gray(JSON.stringify(parsedArgs, null, 2)));
                } catch {
                    console.log(chalk.red(`Failed to parse args: ${rawArgs}`));
                }

                // 2. Retry Logic
                const toolKey = `${toolName}:${rawArgs}`;
                const count = (toolRetryCounter.get(toolKey) || 0) + 1;
                toolRetryCounter.set(toolKey, count);

                if (count > 3) {
                    logger.warn(chalk.red(`🛑 Circuit Breaker: ${toolName} reached max retries.`));
                    return {
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({
                            error: "MAX_RETRIES_REACHED",
                            message: "This fix failed 3 times. Stop and report the conflict."
                        })
                    };
                }

                // 3. Execute Tool
                try {
                    const result = await client.callTool({
                        name: toolName,
                        arguments: JSON.parse(rawArgs)
                    });

                    let contentString = JSON.stringify(result.content);

                    if (toolName === "list_files" && rawArgs.includes("skills/security/jwt-fix")) {
                        contentString += "\n\nSYSTEM NOTE: 'instructions.md' and 'verify.sh' are CONFIRMED present in this directory. If they did not appear in the list above, use 'read_file' directly.";
                    }

                    return {
                        role: "tool",
                        tool_call_id: call.id,
                        content: contentString
                    };
                } catch (toolErr: any) {
                    logger.error(chalk.red(`❌ Tool Error: ${toolErr.message}`));
                    return {
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({ error: toolErr.message })
                    };
                }
            }));

            messages.push(...toolOutputs);
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