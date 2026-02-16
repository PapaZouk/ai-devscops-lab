import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import { deriveRunTestsFailureFingerprint } from "../utils/deriveRunTestsFailureFingerprint.js";
import { deriveRunTestsFailureHint } from "../utils/deriveRunTestsFailureHint.js";
import { isDeliveryRunCommandCall } from "../utils/isDeliveryRunCommandCall.js";
import { sanitizeToolArgsForLog } from "../utils/sanitizeToolArgsForLog.js";
import { truncateOutputText } from "../utils/truncateOutputText.js";
import { Tool } from "../types/tool.js";
import { BaseProcessToolCallParams } from "../types/BaseProcessToolCallParams.js";
import { ProcessToolCallParams } from "../types/ProcessToolCallParams.js";

const logger = getLogger("orchestrator");

export function createToolCallProcessor(baseParams: BaseProcessToolCallParams) {
    const toolRetryCounter = new Map<string, number>();
    return async (call: any) =>
        processToolCall({
            ...baseParams,
            call,
            toolRetryCounter,
        });
}

async function processToolCall({
    call,
    client,
    isTestingAgent,
    maxToolRetries,
    maxRunTestsConsecutiveFailures,
    toolRetryCounter,
    state,
    targetSourcePath,
    maxHistoryToolOutput,
}: ProcessToolCallParams): Promise<{
    toolOutput: { role: "tool"; tool_call_id: string; content: string };
    postToolSystemMessages: string[];
}> {
    const postToolSystemMessages: string[] = [];

    const makeToolOutput = (content: string | Record<string, unknown>) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: typeof content === "string" ? content : JSON.stringify(content),
    });

    if (call.type !== "function") {
        return {
            toolOutput: makeToolOutput({ error: "Unsupported tool type" }),
            postToolSystemMessages,
        };
    }

    const toolName = call.function.name;
    const rawArgs = call.function.arguments || "{}";

    let parsedArgs: Record<string, unknown> = {};
    try {
        parsedArgs = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    } catch {
        parsedArgs = {};
    }

    logger.info(chalk.yellow(`🔧 Tool: ${toolName}`));
    console.log(chalk.gray(sanitizeToolArgsForLog(rawArgs)));

    const toolKey = `${toolName}:${rawArgs}`;
    const count = (toolRetryCounter.get(toolKey) || 0) + 1;
    toolRetryCounter.set(toolKey, count);

    if (isTestingAgent && !state.hasPassingTestRun && isDeliveryRunCommandCall(toolName, rawArgs)) {
        logger.warn(chalk.yellow("🛑 Delivery blocked: run_tests has not passed yet."));
        return {
            toolOutput: makeToolOutput({
                error: "DELIVERY_BLOCKED_BEFORE_TEST_PASS",
                message:
                    "Delivery commands (git/gh) are blocked until run_tests returns {\"passed\": true}. " +
                    "Implement/fix tests and rerun run_tests.",
            }),
            postToolSystemMessages,
        };
    }

    if (isTestingAgent) {
        const isDiscoverTool = [Tool.ReadFile, Tool.ScanProject, Tool.ListUntestedFiles, Tool.AnalyzeFile].includes(toolName);
        if (
            state.testingPhase === "discover" &&
            !state.discoveredContext &&
            (toolName === Tool.WriteTestFile || toolName === Tool.RunTests)
        ) {
            return {
                toolOutput: makeToolOutput({
                    error: "DISCOVERY_REQUIRED",
                    message:
                        "Before writing/running tests, gather context with read_file/analyze_file/scan_project/list_untested_files.",
                }),
                postToolSystemMessages,
            };
        }

        if (isDiscoverTool) {
            state.discoveredContext = true;
        }

        if (state.testingPhase === "remediate" && toolName === Tool.WriteTestFile) {
            if (!state.remediationTestReadDone) {
                return {
                    toolOutput: makeToolOutput({
                        error: "REMEDIATION_READ_TEST_REQUIRED",
                        message: "Read the failing test file before rewriting during remediation.",
                        requiredAction: {
                            tool: Tool.ReadFile,
                            arguments: { file_path: state.lastFailingTestPath || "tests/<failing>.test.ts" },
                        },
                    }),
                    postToolSystemMessages,
                };
            }

            if (state.remediationRequiresSourceRead && !state.remediationSourceReadDone) {
                return {
                    toolOutput: makeToolOutput({
                        error: "REMEDIATION_READ_SOURCE_REQUIRED",
                        message: "Read the target source file before rewriting this failure type.",
                        requiredAction: {
                            tool: Tool.ReadFile,
                            arguments: { file_path: targetSourcePath || "src/<target>.ts" },
                        },
                    }),
                    postToolSystemMessages,
                };
            }
        }

        if (state.testingPhase === "remediate" && toolName === Tool.RunTests && !state.wroteTestSinceLastRun) {
            return {
                toolOutput: makeToolOutput({
                    error: "PATCH_REQUIRED_BEFORE_RERUN",
                    message: "Repeated failure remediation requires a test patch before rerunning run_tests.",
                }),
                postToolSystemMessages,
            };
        }
    }

    if (toolName === Tool.RunTests) {
        if (state.consecutiveRunTestsFailures >= maxRunTestsConsecutiveFailures) {
            logger.warn(chalk.red("🛑 Circuit Breaker: run_tests reached max consecutive failures."));
            return {
                toolOutput: makeToolOutput({
                    error: "MAX_RUN_TESTS_RETRIES_REACHED",
                    message:
                        `run_tests failed ${state.consecutiveRunTestsFailures} times consecutively. ` +
                        "Update tests or scope before retrying.",
                }),
                postToolSystemMessages,
            };
        }
    } else if (count > maxToolRetries) {
        logger.warn(chalk.red(`🛑 Circuit Breaker: ${toolName} reached max retries.`));
        return {
            toolOutput: makeToolOutput({
                error: "MAX_RETRIES_REACHED",
                message: `This action failed ${maxToolRetries} times. Stop and report the conflict.`,
            }),
            postToolSystemMessages,
        };
    }

    try {
        const result = await client.callTool({
            name: toolName,
            arguments: parsedArgs,
        });

        const resultContent = Array.isArray((result as any).content) ? (result as any).content : [];
        let contentString = truncateOutputText(JSON.stringify(resultContent), maxHistoryToolOutput);

        const toolText = resultContent
            .map((content: any) => (typeof content.text === "string" ? content.text : ""))
            .filter(Boolean)
            .join("\n");

        if (toolText) {
            console.log(chalk.gray(`🧾 Tool Output (${toolName}):\n${toolText}`));
        }

        if (toolName === Tool.RunTests) {
            let runTestsPassedThisAttempt = false;
            if (toolText) {
                try {
                    const parsed = JSON.parse(toolText);
                    if (parsed?.summary || typeof parsed?.stderr === "string") {
                        state.lastRunTestsSummary = JSON.stringify(
                            {
                                passed: parsed?.passed,
                                exitCode: parsed?.exitCode,
                                summary: parsed?.summary,
                                effectiveTestPathPattern: parsed?.effectiveTestPathPattern ?? null,
                                stderr:
                                    typeof parsed?.stderr === "string"
                                        ? truncateOutputText(parsed.stderr, 800)
                                        : "",
                            },
                            null,
                            2
                        );
                    }

                    if (parsed?.passed === true) {
                        state.hasPassingTestRun = true;
                        runTestsPassedThisAttempt = true;
                    }

                    if (runTestsPassedThisAttempt) {
                        state.testingPhase = "done";
                        state.runTestsFailureStreakHinted = 0;
                        state.repeatedRunTestsFailureCount = 0;
                        state.lastRunTestsFailureFingerprint = null;
                        state.lastFailingTestPath = null;
                        state.remediationRequiresSourceRead = false;
                        state.remediationTestReadDone = false;
                        state.remediationSourceReadDone = false;
                    } else if (typeof parsed?.stderr === "string") {
                        state.testingPhase = "remediate";
                        state.wroteTestSinceLastRun = false;

                        const currentFingerprint = deriveRunTestsFailureFingerprint(parsed.stderr);
                        if (currentFingerprint === state.lastRunTestsFailureFingerprint) {
                            state.repeatedRunTestsFailureCount += 1;
                        } else {
                            state.repeatedRunTestsFailureCount = 1;
                            state.lastRunTestsFailureFingerprint = currentFingerprint;
                        }

                        const failedFile =
                            parsed?.fileResults?.find?.((resultItem: any) => resultItem?.status === "fail")
                                ?.file ??
                            parsed?.effectiveTestPathPattern ??
                            null;
                        if (typeof failedFile === "string" && failedFile.trim()) {
                            state.lastFailingTestPath = failedFile.trim();
                        }

                        const failureType = String(parsed?.failureDiagnostics?.failureType ?? "").trim() || null;
                        state.remediationRequiresSourceRead = [
                            "module_resolution",
                            "esm_named_export",
                            "assertion_equality",
                            "assertion_length",
                        ].includes(failureType ?? "");
                        state.remediationTestReadDone = false;
                        state.remediationSourceReadDone = false;

                        const hint = deriveRunTestsFailureHint(parsed.stderr);
                        if (hint) {
                            state.runTestsFailureStreakHinted += 1;
                            if (state.runTestsFailureStreakHinted >= 2) {
                                postToolSystemMessages.push(
                                    `Repeated run_tests failures detected. ${hint} ` +
                                    "Read the failing test file and dependent runtime modules before rewriting tests."
                                );
                            }
                        }
                    }
                } catch {
                    // Ignore parse failures; run_tests output is best-effort structured.
                }
            }

            if (runTestsPassedThisAttempt) {
                state.consecutiveRunTestsFailures = 0;
            } else {
                state.consecutiveRunTestsFailures += 1;
            }
        }

        if (toolName === Tool.ReadFile) {
            const readPath = String(parsedArgs.file_path ?? "").trim();
            if (
                readPath &&
                state.lastFailingTestPath &&
                (readPath === state.lastFailingTestPath || readPath.endsWith(state.lastFailingTestPath))
            ) {
                state.remediationTestReadDone = true;
            }
            if (readPath && targetSourcePath && (readPath === targetSourcePath || readPath.endsWith(targetSourcePath))) {
                state.remediationSourceReadDone = true;
            }
        }

        if (toolName === Tool.WriteTestFile && toolText) {
            try {
                const parsed = JSON.parse(toolText);
                if (parsed?.success === true) {
                    state.testingPhase = "verify";
                    state.wroteTestSinceLastRun = true;
                    for (const key of [...toolRetryCounter.keys()]) {
                        if (key.startsWith("run_tests:")) {
                            toolRetryCounter.delete(key);
                        }
                    }
                }
            } catch {
                // Ignore parse failures; write_test_file output is best-effort structured.
            }
        }

        if (toolName === Tool.ListFiles && rawArgs.includes("skills/security/jwt-fix")) {
            contentString +=
                "\n\nSYSTEM NOTE: 'instructions.md' and 'verify.sh' are CONFIRMED present in this directory. " +
                "If they did not appear in the list above, use 'read_file' directly.";
        }

        return {
            toolOutput: makeToolOutput(contentString),
            postToolSystemMessages,
        };
    } catch (error: any) {
        logger.error(chalk.red(`❌ Tool Error: ${error.message}`));
        if (toolName === Tool.RunTests) {
            state.consecutiveRunTestsFailures += 1;
        }
        return {
            toolOutput: makeToolOutput({ error: error.message }),
            postToolSystemMessages,
        };
    }
}
