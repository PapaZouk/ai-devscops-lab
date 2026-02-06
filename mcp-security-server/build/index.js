import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleSecureWrite } from "./tools/secureWrite.js";
import z from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import db from "./utils/db.js";
import { handleReadFile } from "./tools/readFile.js";
import { handleListFiles } from "./tools/listFiles.js";
import { handleRunCommand } from "./tools/run_command.js";
const PROJECT_ROOT = process.env.API_ROOT || process.cwd();
const server = new McpServer({
    name: 'security-remediation-server',
    version: '1.0.0',
});
server.registerTool("secure_write", {
    title: "Secure Write & Lint",
    description: "Writes code to a file after verifying paths and linting with Biome.",
    inputSchema: {
        path: z.string().describe("Relative path to the file"),
        code: z.string().describe("The full file content to write"),
        isTest: z.boolean().describe("True if writing a test file"),
    }
}, async (args, _extra) => {
    const result = await handleSecureWrite(PROJECT_ROOT, args);
    return {
        ...result,
        content: result.content.map(item => ({
            ...item,
            type: "text"
        }))
    };
});
server.registerTool("get_audit_logs", {
    title: "Get Audit Logs",
    description: "Retrieves the history of security remediations and linting status from the local database.",
    inputSchema: {
        limit: z.number().optional().default(5).describe("Number of recent logs to retrieve"),
        status: z.enum(["SUCCESS", "LINT_ERROR"]).optional().describe("Filter logs by status")
    }
}, async (args) => {
    let query = "SELECT * FROM audit_logs";
    const params = [];
    if (args.status) {
        query += " WHERE status = ?";
        params.push(args.status);
    }
    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(args.limit);
    const logs = db.prepare(query).all(...params);
    return {
        content: [{
                type: "text",
                text: JSON.stringify(logs, null, 2)
            }],
        isError: false
    };
});
server.registerTool("read_file", {
    title: "Read File",
    description: "Reads the content of a file within the project directory for analysis.",
    inputSchema: {
        path: z.string().describe("Relative path to the file to read")
    }
}, async (args, _extra) => {
    const result = await handleReadFile(PROJECT_ROOT, args);
    return {
        ...result,
        content: result.content.map(item => ({
            ...item,
            type: "text"
        }))
    };
});
server.registerTool("list_files", {
    title: "List Directory Contents",
    description: "Lists files and directories within a specific path to help explore the project structure.",
    inputSchema: {
        path: z.string().describe("Relative path to the directory to list (use '.' for root)"),
        recursive: z.boolean().optional().describe("Whether to list subdirectories (defaults to false)")
    }
}, async (args, _extra) => {
    const result = await handleListFiles(PROJECT_ROOT, args);
    return {
        ...result,
        content: [{
                type: "text",
                text: JSON.stringify(result.content, null, 2)
            }]
    };
});
server.registerTool("run_command", {
    title: "Execute Secure Commands",
    description: "Runs allowed system commands like 'npm test' to verify code changes.",
    inputSchema: {
        command: z.string().describe("The command to run (must be in allowlist)")
    }
}, async (args) => {
    return await handleRunCommand(PROJECT_ROOT, args);
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Security MCP Server running on Stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map