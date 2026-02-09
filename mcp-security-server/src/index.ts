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
            path: z.string().describe("The absolute or relative path to the file")
        })
    },
    async (args) => {
        logger.debug(`Operation: read_file | Path: ${args.path}`);
        const result = await handleReadFile(PROJECT_ROOT, args);
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
            path: z.string().describe("Path to list (use '.' for workbench root)"),
            recursive: z.boolean().optional().default(false)
        })
    },
    async (args) => {
        logger.debug(`Operation: list_files | Path: ${args.path}`);
        const result = await handleListFiles(PROJECT_ROOT, args); return {
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
        description: "Executes shell commands, build tools, or verification scripts found in skills.",
        inputSchema: z.object({
            command: z.string().optional(),
            cmd: z.any().optional()
        })
    },
    async (args) => {
        // 1. Resolve the input (handle both 'command' and 'cmd')
        let rawCmd = args.command || args.cmd;

        // 2. If the AI sent an array (e.g. ["bash", "-lc", "..."]), join it
        if (Array.isArray(rawCmd)) {
            rawCmd = rawCmd.join(" ");
        }

        if (!rawCmd || typeof rawCmd !== 'string') {
            return {
                content: [{ type: "text", text: "Error: No command string provided." }],
                isError: true
            };
        }

        logger.info(chalk.yellow(`Operation: run_command | Cmd: ${rawCmd}`));

        // 3. Call your modular handler
        const result = await handleRunCommand(PROJECT_ROOT, { command: rawCmd });

        // 4. Ensure we return the correct MCP shape
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