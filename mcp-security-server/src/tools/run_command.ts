import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import db from "../utils/db.js";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";

const execPromise = promisify(exec);
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

    // Build the command based on provided arguments
    if (args.path) {
        let scriptPhysicalPath: string;
        if (args.path.startsWith("./skills") || args.path.startsWith("skills")) {
            if (!skillsPath) throw new McpError(ErrorCode.InvalidParams, "SKILLS_PATH not configured.");
            const relativePart = args.path.replace(/^(\.\/)?skills/, "");
            scriptPhysicalPath = path.resolve(skillsPath, relativePart.startsWith("/") ? relativePart.slice(1) : relativePart);
        } else {
            scriptPhysicalPath = path.resolve(projectRoot, args.path);
        }

        const scriptArgs = args.args ? args.args.join(" ") : "";
        commandToExecute = `bash "${scriptPhysicalPath}" ${scriptArgs}`;

    } else if (args.command || (args as any).cmd) {
        // Handle both 'command' and 'cmd' (agent hallucination)
        const baseCmd = args.command || (args as any).cmd;
        const extraArgs = args.args ? args.args.join(" ") : "";
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
        const { stdout, stderr } = await execPromise(commandToExecute, {
            cwd: projectRoot,
            timeout: 60000,
            env: {
                ...process.env,
                PROJECT_ROOT: projectRoot,
                GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
            }
        });

        const output = stdout || stderr;
        const status = stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS';

        // 3. Audit Logging (Preserved from your version)
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, status, output);

        return {
            content: [{
                type: "text" as const,
                text: output
            }],
            isError: false
        };
    } catch (error: any) {
        const errorMessage = error.stdout || error.stderr || error.message || "Unknown error";

        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${commandToExecute}`, 'COMMAND_ERROR', errorMessage);

        return {
            content: [{
                type: "text" as const,
                text: errorMessage
            }],
            isError: false // Kept as false per your requirement to let agent see error output
        };
    }
}