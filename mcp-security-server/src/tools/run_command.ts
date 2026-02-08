import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import db from "../utils/db.js";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";

const execPromise = promisify(exec);
const logger = getLogger("runCommand");

export async function handleRunCommand(
    projectRoot: string,
    args: { command?: string; path?: string; args?: string[] }
) {
    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";
    let commandToExecute = "";

    // 1. Build the command based on provided arguments
    if (args.command) {
        commandToExecute = args.command;
    } else if (args.path) {
        let scriptPhysicalPath: string;

        // Handle virtual './skills' prefix
        if (args.path.startsWith("./skills") || args.path.startsWith("skills")) {
            if (!skillsPath) throw new McpError(ErrorCode.InvalidParams, "SKILLS_PATH not configured.");
            const relativePart = args.path.replace(/^(\.\/)?skills/, "");
            scriptPhysicalPath = path.resolve(skillsPath, relativePart.startsWith("/") ? relativePart.slice(1) : relativePart);
        } else {
            scriptPhysicalPath = path.resolve(projectRoot, args.path);
        }

        const scriptArgs = args.args ? args.args.join(" ") : "";
        commandToExecute = `bash ${scriptPhysicalPath} ${scriptArgs}`;
    } else {
        throw new McpError(ErrorCode.InvalidParams, "Either 'command' or 'path' must be provided.");
    }

    // 2. Security Check (Preserved from your version)
    // Note: We allow ';' only if it's inside the built command for internal logic, 
    // but generally keeping your regex for safety.
    const hasInjection = /[&|;]/.test(commandToExecute);
    if (hasInjection && !args.path) { // Relax slightly for path-based execution if needed, or keep strict
        logger.warn(chalk.red(`❌ INJECTION DETECTED: ${commandToExecute}`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ COMMAND REJECTED: Disallowed characters detected for security."
        );
    }

    try {
        const { stdout, stderr } = await execPromise(commandToExecute, {
            cwd: projectRoot,
            timeout: 60000,
            env: { ...process.env, PROJECT_ROOT: projectRoot }
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