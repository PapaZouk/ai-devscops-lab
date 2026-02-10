import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";
import { handleReadFile } from "./tools/readFile.js";
import { handleListFiles } from "./tools/listFiles.js";
import { handleSecureWrite } from "./tools/secureWrite.js";
import { handleRunCommand } from "./tools/run_command.js";
import chalk from "chalk";
import { handleGitDiff } from "./tools/gitDiff.js";
import { handleMemory } from "./tools/manageMemory.js";

await setupLogger();
const logger = getLogger("mcp-server");

const PROJECT_ROOT = process.env.CWD || process.cwd();

const server = new McpServer({
    name: 'security-utility-server',
    version: '1.0.0',
});

server.registerTool(
    "read_file",
    {
        description: "Reads the content of a file from the workbench or the skills library.",
        inputSchema: z.object({
            path: z.string().optional().describe("The absolute or relative path to the file")
        })
    },
    async (args) => {
        const requestedPath = args?.path;
        logger.debug(`Operation: read_file | Path: ${requestedPath ?? "(missing)"}`);

        if (!requestedPath) {
            return {
                content: [{
                    type: "text" as const,
                    text: "Error: Missing 'path'. Provide a file path to read."
                }],
                isError: true
            };
        }

        const result = await handleReadFile(PROJECT_ROOT, { path: requestedPath });
        return {
            content: result.content.map(c => ({ type: "text" as const, text: c.text }))
        };
    }
);

server.registerTool(
    "list_files",
    {
        description: "Lists files and directories to help explore the project or the skills library.",
        inputSchema: z.object({
            path: z.string().optional().describe("Path to list"),
            directory: z.string().optional().describe("Alias for path"),
            recursive: z.boolean().optional().default(false)
        })
    },
    async (args) => {
        const finalPath = args?.path || args?.directory || ".";
        logger.debug(`Operation: list_files | Path: ${finalPath}`);

        const result = await handleListFiles(PROJECT_ROOT, {
            path: finalPath,
            recursive: args?.recursive
        });

        return {
            content: [{
                type: "text" as const,
                text: result.content[0].text
            }]
        };
    }
);

server.registerTool(
    "write_file",
    {
        description: "Writes code to a file. Used for applying security patches.",
        inputSchema: z.object({
            path: z.string().describe("Relative path to the file"),
            code: z.string().optional(),
            content: z.string().optional(),
            isTest: z.boolean().optional()
        })
    },
    async (args) => {
        // Resolve which property the AI used
        const finalCode = args.code || args.content;
        if (!finalCode) {
            return { content: [{ type: "text", text: "Error: Missing 'code' or 'content' field." }], isError: true };
        }

        logger.info(chalk.magenta(`Operation: write_file | File: ${args.path}`));
        const result = await handleSecureWrite(PROJECT_ROOT, {
            path: args.path,
            code: finalCode,
            isTest: args.isTest
        });

        return {
            content: result.content.map(c => ({ type: "text" as const, text: c.text }))
        };
    }
);

server.registerTool(
    "run_command",
    {
        description: "Executes a command in the workbench. " +
            "FOR SCRIPTS: Use 'path' and 'args'. Do NOT use 'bash -lc' or shell redirects (>, |) as they are rejected. " +
            "DELIVERY: Once a security fix is verified, you MUST use this tool to execute the Git & Pull Request protocol (git checkout, commit, gh pr create).",
        inputSchema: z.object({
            command: z.string().optional(),
            cmd: z.any().optional(),
            args: z.array(z.string()).optional(),
            path: z.string().optional()
        })
    },
    async (args) => {
        // 1. Resolve the input (handle both 'command' and 'cmd')
        let rawCmd = args.command || args.cmd;

        // 2. If the AI sent an array (e.g. ["bash", "-lc", "..."]), join it
        if (Array.isArray(rawCmd)) {
            rawCmd = rawCmd.join(" ");
        }

        if ((!rawCmd || typeof rawCmd !== 'string') && !args.path) {
            return {
                content: [{ type: "text", text: "Error: No command string provided." }],
                isError: true
            };
        }

        logger.info(
            chalk.yellow(
                `Operation: run_command | Cmd: ${rawCmd ?? "(path mode)"}${args.path ? ` | Path: ${args.path}` : ""}`
            )
        );

        // 3. Call your modular handler
        const result = await handleRunCommand(PROJECT_ROOT, {
            command: typeof rawCmd === "string" ? rawCmd : undefined,
            path: args.path,
            args: args.args
        });

        // 4. Ensure we return the correct MCP shape
        return {
            content: result.content.map(c => ({ type: "text" as const, text: c.text }))
        };
    }
);

server.registerTool(
    "git_diff",
    {
        description: "Shows unstaged changes in the project. Use this to verify your patch before finalizing.",
        inputSchema: z.object({})
    },
    async () => {
        logger.debug(`Operation: git_diff`);
        const result = await handleGitDiff(PROJECT_ROOT);
        return {
            content: result.content.map(c => ({ type: "text" as const, text: c.text }))
        };
    }
);

server.registerTool(
    "manage_memory",
    {
        description: "Stores or retrieves technical observations (like discovered file paths or error logs) to maintain context across turns. " +
            "Use 'store' to remember a path/finding, and 'recall' to see everything you've noted.",
        inputSchema: z.object({
            action: z.enum(["store", "recall"]).optional().describe("Whether to save a new memory or retrieve all existing ones"),
            key: z.string().optional().describe("A label for the memory (e.g., 'vulnerable_file', 'verification_status')"),
            value: z.string().optional().describe("The actual information to remember")
        })
    },
    async (args) => {
        const inferredAction =
            args.action ??
            (args.key || args.value ? "store" : "recall");

        logger.debug(`Operation: manage_memory | Action: ${inferredAction}`);

        const result = await handleMemory({
            action: inferredAction as "store" | "recall",
            key: args.key,
            value: args.value
        });

        return {
            content: result.content.map(c => ({ type: "text" as const, text: c.text }))
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(chalk.green.bold(`\n🟢 GENERIC SECURITY MCP ONLINE`));
    console.error(chalk.gray(`📂 Workbench Root: ${PROJECT_ROOT}`));
}

main().catch((err) => {
    logger.error(`❌ Fatal server error: ${err.message}`);
    process.exit(1);
});
