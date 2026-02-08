import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleSecureWrite } from "../tools/secureWrite.js";
import { handleReadFile } from "../tools/readFile.js";
import { handleListFiles } from "../tools/listFiles.js";
import { handleRunCommand } from "../tools/run_command.js";
import z from "zod";
import db from "../utils/db.js";

export default function registerTools(server: McpServer, projectRoot: string) {
    server.registerTool(
        "secure_write",
        {
            title: "Secure Write & Lint",
            description: "Writes code to a file after verifying paths and linting with Biome.",
            inputSchema: {
                path: z.string().describe("Relative path to the file"),
                code: z.string().describe("The full file content to write"),
                isTest: z.boolean().describe("True if writing a test file"),
            }
        },
        async (args, _extra) => {
            const result = await handleSecureWrite(projectRoot, args);
            return {
                ...result,
                content: result.content.map(item => ({
                    ...item,
                    type: "text" as const
                }))
            };
        }
    );

    server.registerTool(
        "get_audit_logs",
        {
            title: "Get Audit Logs",
            description: "Retrieves the history of security remediations and linting status from the local database.",
            inputSchema: {
                limit: z.number().optional().default(5).describe("Number of recent logs to retrieve"),
                status: z.enum(["SUCCESS", "LINT_ERROR"]).optional().describe("Filter logs by status")
            }
        },
        async (args) => {
            let query = "SELECT * FROM audit_logs";
            const params: any[] = [];

            if (args.status) {
                query += " WHERE status = ?";
                params.push(args.status);
            }

            query += " ORDER BY timestamp DESC LIMIT ?";
            params.push(args.limit);

            const logs = db.prepare(query).all(...params);

            return {
                content: [{
                    type: "text" as const,
                    text: JSON.stringify(logs, null, 2)
                }],
                isError: false
            };
        }
    )

    server.registerTool(
        "read_file",
        {
            title: "Read File",
            description: "Reads the content of a file within the project directory for analysis.",
            inputSchema: {
                path: z.string().describe("Relative path to the file to read")
            }
        },
        async (args, _extra) => {
            const result = await handleReadFile(projectRoot, args);
            return {
                ...result,
                content: result.content.map(item => ({
                    ...item,
                    type: "text" as const
                }))
            };
        }
    );

    server.registerTool(
        "list_files",
        {
            title: "List Directory Contents",
            description: "Lists files and directories within a specific path to help explore the project structure.",
            inputSchema: {
                path: z.string().describe("Relative path to the directory to list (use '.' for root)"),
                recursive: z.boolean().optional().describe("Whether to list subdirectories (defaults to false)")
            }
        },
        async (args, _extra) => {
            const result = await handleListFiles(projectRoot, args);
            return {
                ...result,
                content: [{
                    type: "text" as const,
                    text: JSON.stringify(result.content, null, 2)
                }]
            };
        }
    );

    server.registerTool(
        "run_command",
        {
            title: "Execute Secure Commands",
            description: "Runs allowed system commands like 'npm test' to verify code changes.",
            inputSchema: {
                command: z.string().describe("The command to run (must be in allowlist)")
            }
        },
        async (args) => {
            return await handleRunCommand(projectRoot, args);
        }
    );

    server.registerTool(
        "git_manager",
        {
            title: "Git Manager",
            description: "Performs Git operations like creating branches, committing changes, and pushing to remote.",
            inputSchema: {
                action: z.enum(["create_branch", "commit_changes", "push_to_remote"]).describe("Git action to perform"),
                branchName: z.string().optional().describe("Name of the branch to create (required for create_branch)"),
                commitMessage: z.string().optional().describe("Commit message (required for commit_changes)"),
                remoteName: z.string().optional().describe("Remote name to push to (required for push_to_remote)")
            }
        },
        async (args) => {
            const targetPath = projectRoot; // Git operations will be performed in the project root
            return {
                content: [{
                    type: "text" as const,
                    text: `Git action '${args.action}' executed successfully (this is a placeholder response).`
                }],
                isError: false
            }
        }
    );
}