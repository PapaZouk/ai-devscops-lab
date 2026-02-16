import { OpenAI } from "openai";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";
import type { AgentConfig } from "./types/agentConfig.js";
import { configDotenv } from "dotenv";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai/build/src/instrumentation.js";
import { getOrchestratorRuntimeConfig } from "./config/orchestratorConfig.js";
import { sanitizeAssistantMessageForHistory } from "./utils/sanitizeAssistantMessageForHistory.js";
import { createChatCompletionWithRateLimit } from "./services/chatCompletionService.js";
import { createToolCallProcessor } from "./services/processToolCall.js";
import { getSystemPrompt } from "./utils/prompts/getSystemPrompt.js";
import { getClientTransport, getMcpClient } from "./config/getMcpClient.js";
import type { TestingToolState } from "./types/TestingToolState.js";
import { getSkillsPath } from "./config/getSkillsPath.js";
import { RUN_TESTS_REMINDER_PROMPT, TESTING_AGENT_FAILURE_SUMMARY_PROMPT } from "./errors/index.js";
import { getInitialTestingToolState } from "./config/getInitialTestingToolState.js";

configDotenv();

const openTelemetry = new NodeSDK({
    instrumentations: [new OpenAIInstrumentation()]
});
openTelemetry.start();

const logger = getLogger("orchestrator");

export async function startOrchestrator(config: AgentConfig, targetPath: string, userPrompt: string) {
    logger.info(chalk.blue.bold("🚀 Starting Orchestrator..."));
    logger.info(chalk.blue(`📁 Target Project: ${targetPath}`));

    const serverPath = path.resolve(
        process.cwd(),
        config.mcpServerPath || "../mcp-security-server/build/index.js"
    );
    const skillsPath = await getSkillsPath();

    const client = await getMcpClient(config, skillsPath, serverPath, targetPath);

    if (!client || "success" in client) {
        logger.error(chalk.red("❌ Orchestrator failed to start due to MCP connection issues."));
        return client;
    }

    const { tools } = await client.listTools();
    logger.info(chalk.green.bold(`🛠 Discovered ${tools.length} tools.`));

    const runtimeConfig = getOrchestratorRuntimeConfig();
    const maxRateLimitRetries = runtimeConfig.maxRateLimitRetries;
    const currentModel = config.model;
    logger.info(chalk.blue(`Using LLM at ${runtimeConfig.lmBaseUrl} with model ${currentModel}.`));

    const openai = new OpenAI({
        baseURL: runtimeConfig.lmBaseUrl,
        apiKey: runtimeConfig.lmApiKey
    });

    if (runtimeConfig.shouldSkipDelivery) {
        logger.info(chalk.yellow("🧪 Local mode detected: PR delivery steps are disabled."));
    }

    const runtimeSystemPrompt = getSystemPrompt(config, runtimeConfig);

    let messages: any[] = [
        { role: "system", content: runtimeSystemPrompt },
        { role: "user", content: config.generatePrompt ? config.generatePrompt(".", userPrompt) : userPrompt }
    ];

    const maxToolRetries = runtimeConfig.maxToolRetries;
    const maxRunTestsConsecutiveFailures = runtimeConfig.maxRunTestsConsecutiveFailures;
    const testingState: TestingToolState = getInitialTestingToolState();
    const isTestingAgent = config.name.toLowerCase().includes("testing");

    const processToolCall = createToolCallProcessor({
        client,
        isTestingAgent,
        maxToolRetries,
        maxRunTestsConsecutiveFailures,
        state: testingState,
        targetSourcePath: runtimeConfig.targetSourcePath,
        maxHistoryToolOutput: runtimeConfig.maxHistoryToolOutput,
    });

    const maxTurns = runtimeConfig.maxTurns;
    let turns = 0;
    let consecutiveEmptyAssistantTurns = 0;
    let finalizationGuardPrompts = 0;
    let allowFailureSummaryFinalization = false;

    while (turns < maxTurns) {
        turns++;
        const completion = await createChatCompletionWithRateLimit({
            openai,
            model: currentModel,
            messages: messages as any,
            tools: tools.map(t => ({ type: "function" as const, function: t })),
            maxRateLimitRetries,
            logger: { warn: (msg) => logger.warn(msg), error: (msg) => logger.error(msg) },
            warnColorize: (msg) => chalk.yellow(msg),
            errorColorize: (msg) => chalk.red(msg),
        });
        const response = completion.response;
        messages = completion.messages as any[];

        const message = response.choices[0].message;
        const finishReason = response.choices[0].finish_reason;
        messages.push(sanitizeAssistantMessageForHistory(message, runtimeConfig.maxHistoryToolArgs));

        logger.info(chalk.gray(`💬 Turn ${turns}: AI Message Received (role: ${message.role})`));

        if (message.tool_calls && message.tool_calls.length > 0) {
            consecutiveEmptyAssistantTurns = 0;
            const toolOutputs: any[] = [];
            const postToolSystemMessages: string[] = [];

            for (const call of message.tool_calls) {
                const processed = await processToolCall(call);
                toolOutputs.push(processed.toolOutput);
                postToolSystemMessages.push(...processed.postToolSystemMessages);
            }

            messages.push(...toolOutputs);
            if (postToolSystemMessages.length > 0) {
                messages.push({
                    role: "system",
                    content: postToolSystemMessages.join("\n"),
                });
            }
            continue;
        }

        if (message.content) {
            if (isTestingAgent && !testingState.hasPassingTestRun && !allowFailureSummaryFinalization) {
                finalizationGuardPrompts += 1;
                logger.warn(chalk.yellow("⚠️ Passing run_tests result not achieved. Allowing failure-summary finalization."));

                if (finalizationGuardPrompts >= 3) {
                    logger.warn(chalk.yellow("⚠️ Passing run_tests result not achieved. Allowing failure-summary finalization."));
                    messages.push({
                        role: "system",
                        content: TESTING_AGENT_FAILURE_SUMMARY_PROMPT
                    });
                    allowFailureSummaryFinalization = true;
                    continue;
                }

                messages.push({
                    role: "system",
                    content: RUN_TESTS_REMINDER_PROMPT
                });
                continue;
            }

            consecutiveEmptyAssistantTurns = 0;
            logger.info(chalk.cyan(`\n🤖 AI Final Response:\n${message.content}`));
            if (allowFailureSummaryFinalization && testingState.lastRunTestsSummary) {
                logger.info(chalk.cyan(`\n🧪 Last run_tests summary:\n${testingState.lastRunTestsSummary}`));
            }
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
    await getClientTransport(serverPath, targetPath, skillsPath, config.projectRootMode).close();

    return { success: true, report: "Workflow completed." };
}
