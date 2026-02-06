import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import db from "../utils/db.js";

const execPromise = promisify(exec);

const ALLOWED_COMMANDS = [
    "npm run test",
    "npm test",
    "npm run build",
    "npm build",
    "npx biome",
    "npx jest",
    "npx vitest"
];

export async function handleRunCommand(
    projectRoot: string,
    args: { command: string }
) {
    const { command } = args;

    const isAllowed = ALLOWED_COMMANDS.some(allowed => command.startsWith(allowed));

    const hasInjection = /[&|;]/.test(command);

    if (!isAllowed || hasInjection) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `❌ COMMAND NOT ALLOWED: The command "${command}" is not in the list of allowed commands or contains disallowed characters.`
        );
    }

    try {
        const { stdout, stderr } = await execPromise(command, {
            cwd: projectRoot,
            timeout: 60000
        });

        const output = stdout || stderr;
        const status = stderr ? 'COMMAND_WARNING' : 'COMMAND_SUCCESS';

        const stmt =
            db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${command}`, status, output);

        return {
            content: [{
                type: "text" as const,
                text: `✅ Command executed: ${command}\nOutput:\n${output}`
            }],
            isError: !!stderr
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
                text: `⚠️ The command ran, but the tests FAILED:\n\n${errorMessage}`
            }],
            isError: false // Tell MCP the TOOL worked fine, even if the CODE it ran didn't.
        };
    }
}