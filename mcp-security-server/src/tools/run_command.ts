import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";
import { joinOutput } from "../utils/joinOutput.js";
import { saveAuditLog } from "../utils/saveAuditLogs.js";
import { executeCommand } from "../utils/executeCommand.js";
import { buildArgs } from "../utils/buildArgs.js";
import { configureGitIdentity } from "../utils/configureGitIdentity.js";

const logger = getLogger("run_command");

export async function handleRunCommand(
    projectRoot: string,
    args: { command?: string; path?: string; args?: string[] }
) {
    const rawInput = args.command || (args as any).cmd || "";

    if (rawInput.includes("-lc") || rawInput.includes("$(pwd)")) {
        logger.warn(chalk.yellow(`⚠️ REJECTED SHELL HACK: ${rawInput}`));
        return {
            content: [{
                type: "text" as const,
                text: "❌ ERROR: Shell login flags (-lc) and manual path expansion ($(pwd)) are prohibited. " +
                    "Use the 'path' parameter for scripts and 'args' for targets."
            }],
            isError: false
        };
    }

    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";
    let commandToExecute = "";

    if (args.path) {
        const looksLikeScriptPath = args.path.includes("/") || args.path.endsWith(".sh");

        if (!looksLikeScriptPath) {
            const extraArgs = buildArgs(args.args);
            commandToExecute = `${args.path} ${extraArgs}`.trim();
            logger.debug(chalk.gray(`Constructed command for direct execution (no path): ${commandToExecute}`));
        } else {
            let scriptPhysicalPath: string;

            if (args.path.startsWith("./skills") || args.path.startsWith("skills")) {

                if (!skillsPath) {
                    logger.error(chalk.red("❌ SKILLS_PATH is not configured but a skills path was provided in run_command."));
                    throw new McpError(ErrorCode.InvalidParams, "SKILLS_PATH not configured.");
                }

                const relativePart = args.path.replace(/^(\.\/)?skills/, "");

                scriptPhysicalPath = path.resolve(
                    skillsPath,
                    relativePart.startsWith("/") ? relativePart.slice(1) : relativePart
                );

                logger.debug(chalk.gray(`Resolved skills path: ${args.path} -> ${scriptPhysicalPath}`));
            } else {
                scriptPhysicalPath = path.resolve(projectRoot, args.path);
            }

            const scriptArgs = buildArgs(args.args);
            commandToExecute = `bash "${scriptPhysicalPath}" ${scriptArgs}`;
            logger.debug(chalk.gray(`Constructed command for script path: ${commandToExecute}`));
        }

    } else if (args.command || (args as any).cmd) {
        const baseCmd = args.command || (args as any).cmd;
        const extraArgs = buildArgs(args.args);
        commandToExecute = `${baseCmd} ${extraArgs}`.trim();
        logger.debug(chalk.gray(`Constructed command for direct execution: ${commandToExecute}`));

    } else {
        logger.warn(chalk.red("❌ No command or path provided in run_command."));
        throw new McpError(ErrorCode.InvalidParams, "Either 'command' or 'path' must be provided.");
    }

    const hasInjection = /[&|;]/.test(commandToExecute);

    if (hasInjection && !args.path) {
        logger.warn(chalk.red(`❌ INJECTION DETECTED: ${commandToExecute}`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ COMMAND REJECTED: Disallowed characters detected for security."
        );
    }

    logger.info(chalk.cyan(`🛠 EXECUTING: ${commandToExecute}`));
    logger.info(chalk.gray(`📂 CWD: ${projectRoot}`));

    try {
        const { stdout, stderr } = await executeCommand(projectRoot, commandToExecute);

        const output = joinOutput(stdout, stderr);
        const status = stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS';

        await saveAuditLog(projectRoot, commandToExecute, status, output);

        return {
            content: [{
                type: "text" as const,
                text: output
            }],
            isError: false
        };
    } catch (error: any) {
        return await handleError(error, commandToExecute, projectRoot);
    }
}

async function handleError(error: any, commandToExecute: string, projectRoot: string) {
    const errorOutput = joinOutput(error.stdout, error.stderr, error.message);

    if (
        commandToExecute.startsWith("git ")
        && commandToExecute.includes(" commit ")
        && /Author identity unknown|empty ident name/i.test(errorOutput)
    ) {
        try {
            await configureGitIdentity(projectRoot);

            const retry = await executeCommand(projectRoot, commandToExecute);

            const retryOutput = joinOutput(retry.stdout, retry.stderr);

            await saveAuditLog(
                projectRoot,
                commandToExecute,
                "COMMAND_RECOVERED",
                `[auto-configured git identity and retried commit]\n${retryOutput}`,
            );

            return {
                content: [{
                    type: "text" as const,
                    text: `${retryOutput}\n\n[run_command] Auto-recovery applied: configured local git author identity and retried commit.`
                }],
                isError: false
            };
        } catch (retryError: any) {
            const retryErrorOutput = joinOutput(retryError.stdout, retryError.stderr, retryError.message);

            await saveAuditLog(projectRoot, commandToExecute, "COMMAND_ERROR", `[recovery_failed]\n${retryErrorOutput}`);

            return {
                content: [{
                    type: "text" as const,
                    text: `❌ Command Failed after recovery:\n${retryErrorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
                }],
                isError: false
            };
        }
    }

    if (
        commandToExecute.startsWith("gh ")
        && commandToExecute.includes(" pr create")
        && /must first push the current branch to a remote|use the --head flag/i.test(errorOutput)
    ) {
        try {
            await executeCommand(projectRoot, "git push -u origin HEAD");

            const retry = await executeCommand(projectRoot, commandToExecute);
            const retryOutput = joinOutput(retry.stdout, retry.stderr);

            await saveAuditLog(
                projectRoot,
                commandToExecute,
                "COMMAND_RECOVERED",
                `[auto-pushed HEAD and retried PR creation]\n${retryOutput}`
            );

            return {
                content: [{
                    type: "text" as const,
                    text: `${retryOutput}\n\n[run_command] Auto-recovery applied: pushed HEAD and retried PR creation.`
                }],
                isError: false
            };
        } catch (retryError: any) {
            const retryErrorOutput = joinOutput(retryError.stdout, retryError.stderr, retryError.message);

            await saveAuditLog(
                projectRoot,
                commandToExecute,
                "COMMAND_ERROR",
                `[recovery_failed]\n${retryErrorOutput}`
            );

            return {
                content: [{
                    type: "text" as const,
                    text: `❌ Command Failed after recovery:\n${retryErrorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
                }],
                isError: false
            };
        }
    }

    await saveAuditLog(projectRoot, commandToExecute, 'COMMAND_ERROR', errorOutput);

    return {
        content: [{
            type: "text" as const,
            text: `❌ Command Failed:\n${errorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
        }],
        isError: false
    };
}