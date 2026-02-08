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
    args: { command: string }
) {
    const { command } = args;
    const hasInjection = /[&|;]/.test(command);

    if (hasInjection) {
        logger.warn(chalk.red(`❌ INJECTION DETECTED: ${command}`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ COMMAND REJECTED: Disallowed characters detected for security."
        );
    }

    try {
        const { stdout, stderr } = await execPromise(command, {
            cwd: projectRoot,
            timeout: 60000,
            env: { ...process.env, PROJECT_ROOT: projectRoot }
        });

        const output = stdout || stderr;
        const status = stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS';

        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${command}`, status, output);

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
        stmt.run("SYSTEM", `EXEC: ${command}`, 'COMMAND_ERROR', errorMessage);

        return {
            content: [{
                type: "text" as const,
                text: errorMessage
            }],
            isError: false
        };
    }
}