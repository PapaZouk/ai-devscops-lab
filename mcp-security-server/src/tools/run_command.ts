import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import db from "../utils/db.js";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";

const execPromise = promisify(exec);
const logger = getLogger("run_command");

function shellQuote(value: string): string {
    // POSIX-safe single-quote escaping: 'foo'bar' -> 'foo'"'"'bar'
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function executeCommand(projectRoot: string, commandToExecute: string) {
    return execPromise(commandToExecute, {
        cwd: projectRoot,
        timeout: 60000,
        env: {
            ...process.env,
            PROJECT_ROOT: projectRoot,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
        }
    });
}

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

    // Build the command based on provided arguments
    if (args.path) {
        const looksLikeScriptPath = args.path.includes("/") || args.path.endsWith(".sh");

        // Some models send executables in `path` (e.g. path="git", args=["status"]).
        // Treat those as normal commands instead of filesystem scripts.
        if (!looksLikeScriptPath) {
            const extraArgs = args.args ? args.args.map(shellQuote).join(" ") : "";
            commandToExecute = `${args.path} ${extraArgs}`.trim();
        } else {
            let scriptPhysicalPath: string;
            if (args.path.startsWith("./skills") || args.path.startsWith("skills")) {
            if (!skillsPath) throw new McpError(ErrorCode.InvalidParams, "SKILLS_PATH not configured.");
            const relativePart = args.path.replace(/^(\.\/)?skills/, "");
            scriptPhysicalPath = path.resolve(skillsPath, relativePart.startsWith("/") ? relativePart.slice(1) : relativePart);
            } else {
                scriptPhysicalPath = path.resolve(projectRoot, args.path);
            }

            const scriptArgs = args.args ? args.args.map(shellQuote).join(" ") : "";
            commandToExecute = `bash "${scriptPhysicalPath}" ${scriptArgs}`;
        }

    } else if (args.command || (args as any).cmd) {
        const baseCmd = args.command || (args as any).cmd;
        const extraArgs = args.args ? args.args.map(shellQuote).join(" ") : "";
        commandToExecute = `${baseCmd} ${extraArgs}`.trim();

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

        const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "Done (no output).";
        const status = stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS';

        // 3. Audit Logging (Preserved from your version)
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS', output);

        return {
            content: [{
                type: "text" as const,
                text: output
            }],
            isError: false
        };
    } catch (error: any) {
        const errorOutput = [error.stdout, error.stderr, error.message]
            .filter(Boolean)
            .join("\n")
            .trim();

        // Recovery 1: git commit failed because identity is missing.
        // Configure repository-local identity and retry once.
        if (
            commandToExecute.startsWith("git ")
            && commandToExecute.includes(" commit ")
            && /Author identity unknown|empty ident name/i.test(errorOutput)
        ) {
            const fallbackEmail = process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com";
            const fallbackName = process.env.GIT_AUTHOR_NAME || "github-actions[bot]";

            try {
                await executeCommand(projectRoot, `git config user.email ${shellQuote(fallbackEmail)}`);
                await executeCommand(projectRoot, `git config user.name ${shellQuote(fallbackName)}`);
                const retry = await executeCommand(projectRoot, commandToExecute);
                const retryOutput = [retry.stdout, retry.stderr]
                    .filter(Boolean)
                    .join("\n")
                    .trim() || "Done (no output).";

                const stmt = db.prepare(`
                    INSERT INTO audit_logs (file_path, action, status, biome_output) 
                    VALUES (?, ?, ?, ?)
                `);
                stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, "COMMAND_RECOVERED", `[auto-configured git identity]\n${retryOutput}`);

                return {
                    content: [{
                        type: "text" as const,
                        text: `${retryOutput}\n\n[run_command] Auto-recovery applied: configured local git author identity and retried commit.`
                    }],
                    isError: false
                };
            } catch (retryError: any) {
                const retryErrorOutput = [retryError.stdout, retryError.stderr, retryError.message]
                    .filter(Boolean)
                    .join("\n")
                    .trim();

                const stmt = db.prepare(`
                    INSERT INTO audit_logs (file_path, action, status, biome_output) 
                    VALUES (?, ?, ?, ?)
                `);
                stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, "COMMAND_ERROR", `[recovery_failed]\n${retryErrorOutput}`);

                return {
                    content: [{
                        type: "text" as const,
                        text: `❌ Command Failed after recovery:\n${retryErrorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
                    }],
                    isError: false
                };
            }
        }

        // Recovery 2: gh pr create requires pushed head branch.
        // Push HEAD and retry once.
        if (
            commandToExecute.startsWith("gh ")
            && commandToExecute.includes(" pr create")
            && /must first push the current branch to a remote|use the --head flag/i.test(errorOutput)
        ) {
            try {
                await executeCommand(projectRoot, "git push -u origin HEAD");
                const retry = await executeCommand(projectRoot, commandToExecute);
                const retryOutput = [retry.stdout, retry.stderr]
                    .filter(Boolean)
                    .join("\n")
                    .trim() || "Done (no output).";

                const stmt = db.prepare(`
                    INSERT INTO audit_logs (file_path, action, status, biome_output) 
                    VALUES (?, ?, ?, ?)
                `);
                stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, "COMMAND_RECOVERED", `[auto-pushed head]\n${retryOutput}`);

                return {
                    content: [{
                        type: "text" as const,
                        text: `${retryOutput}\n\n[run_command] Auto-recovery applied: pushed HEAD and retried PR creation.`
                    }],
                    isError: false
                };
            } catch (retryError: any) {
                const retryErrorOutput = [retryError.stdout, retryError.stderr, retryError.message]
                    .filter(Boolean)
                    .join("\n")
                    .trim();

                const stmt = db.prepare(`
                    INSERT INTO audit_logs (file_path, action, status, biome_output) 
                    VALUES (?, ?, ?, ?)
                `);
                stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, "COMMAND_ERROR", `[recovery_failed]\n${retryErrorOutput}`);

                return {
                    content: [{
                        type: "text" as const,
                        text: `❌ Command Failed after recovery:\n${retryErrorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
                    }],
                    isError: false
                };
            }
        }

        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, 'COMMAND_ERROR', errorOutput);

        return {
            content: [{
                type: "text" as const,
                text: `❌ Command Failed:\n${errorOutput}\n\nHint: Use 'path' for script files (e.g. ./skills/.../verify.sh) and 'command' for executables (e.g. git, gh).`
            }],
            isError: false // Kept as false per your requirement to let agent see error output
        };
    }
}
