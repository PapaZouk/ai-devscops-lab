import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";
import registerTools from "./config/registerTools.js";

await setupLogger();

const logger = getLogger("mcp-security-server");

const PROJECT_ROOT = process.env.API_ROOT || process.env.CWD || process.cwd();

const server = new McpServer({
    name: 'security-remediation-server',
    version: '1.0.0',
});

registerTools(server, PROJECT_ROOT);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Security MCP Server running on Stdio");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});