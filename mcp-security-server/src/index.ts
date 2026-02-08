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
            path: z.string().min(1).describe("The absolute or relative path to the file")
        })
    },
    async (args) => {
        logger.debug(`Operation: read_file | Path: ${args.path}`);
        const result = await handleReadFile(PROJECT_ROOT, args);
        return {
            content: result.content.map(c => ({
                type: "text" as const,
                text: c.text
            }))
        };
    }
);

server.registerTool(
    "list_files",
    {
        description: "Lists files and directories. Use '.' for the root directory.",
        inputSchema: z.object({
            path: z.string().default(".").describe("Path to list (use '.' for workbench root)"),
            recursive: z.boolean().optional().default(false)
        })
    },
    async (args) => {
        const pathArg = args.path || ".";
        logger.debug(`Operation: list_files | Path: ${pathArg}`);
        const result = await handleListFiles(PROJECT_ROOT, { ...args, path: pathArg });
        return {
            content: result.content.map(c => ({
                type: "text" as const,
                text: c.text
            }))
        };
    }
);

server.registerTool(
    "write_file",
    {
        description: "Writes code to a file. Used for applying security patches.",
        inputSchema: z.object({
            path: z.string().describe("Relative path to the file"),
            contents: z.string().describe("Full content to be written"),
            isTest: z.boolean().optional().describe("Flag if this is a test file")
        })
    },
    async (args) => {
        logger.info(chalk.magenta(`Operation: write_file | File: ${args.path}`));
        const result = await handleSecureWrite(PROJECT_ROOT, { ...args, code: args.contents });
        return {
            content: result.content.map(c => ({
                type: "text" as const,
                text: c.text
            }))
        };
    }
);

server.registerTool(
    "run_command",
    {
        description: "Executes shell commands, build tools, or verification scripts found in skills.",
        inputSchema: z.object({
            command: z.string().optional().describe("The full command string to execute"),
            path: z.string().optional().describe("Path to a script to execute"),
            args: z.array(z.string()).optional().describe("Arguments for the script")
        })
    },
    async (args) => {
        // We pass the raw args object directly. 
        // The handleRunCommand will handle the path-swapping and command building.
        logger.info(chalk.yellow(`Operation: run_command | Request: ${args.path || args.command}`));

        const result = await handleRunCommand(PROJECT_ROOT, args);

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