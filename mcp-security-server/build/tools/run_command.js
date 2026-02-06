import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import db from "../utils/db.js";
const execPromise = promisify(exec);
const ALLOWED_COMMANDS = [
    "npm run test",
    "npm run build",
    "npx biome check",
    "npx biome check --write",
    "npx biome format",
    "npm test"
];
export async function handleRunCommand(projectRoot, args) {
    const { command } = args;
    const isAllowed = ALLOWED_COMMANDS.some(allowed => command.startsWith(allowed));
    const hasInjection = /[&|;]/.test(command);
    if (!isAllowed || hasInjection) {
        throw new McpError(ErrorCode.InvalidParams, `❌ COMMAND NOT ALLOWED: The command "${command}" is not in the list of allowed commands or contains disallowed characters.`);
    }
    try {
        const { stdout, stderr } = await execPromise(command, {
            cwd: projectRoot,
            timeout: 60000
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
                    type: "text",
                    text: `✅ Command executed: ${command}\nOutput:\n${output}`
                }],
            isError: !!stderr
        };
    }
    catch (error) {
        const errorMessage = error.stderr || error.message || "Unknown error";
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run("SYSTEM", `EXEC: ${command}`, 'COMMAND_ERROR', errorMessage);
        throw new McpError(ErrorCode.InternalError, `❌ Command execution failed: ${errorMessage}`);
    }
}
//# sourceMappingURL=run_command.js.map