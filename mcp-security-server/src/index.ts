import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";
import registerTools from "./config/registerTools.js";
import chalk from "chalk";

await setupLogger();
const logger = getLogger("mcp-security-server");

const PROJECT_ROOT = process.env.CWD || process.cwd();

const server = new McpServer({
    name: 'security-remediation-server',
    version: '1.0.0',
});

await registerTools(server, PROJECT_ROOT);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr so it doesn't interfere with the MCP protocol on stdout
    console.error(chalk.green(`🟢 MCP Server online. Root: ${PROJECT_ROOT}`));
}

main().catch((err) => {
    console.error(chalk.red(`❌ Fatal server error: ${err.message}`));
    process.exit(1);
});