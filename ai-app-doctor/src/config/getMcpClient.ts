import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentConfig } from "../types/agentConfig.js";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import chalk from "chalk";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("orchestrator");

export const getClientTransport = (serverPath: string, targetPath: string, skillsPath: string, projectRootMode?: "cwd" | "target") => {
    return new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            PROJECT_ROOT:
                projectRootMode === "target"
                    ? path.resolve(targetPath)
                    : path.resolve(process.cwd()),
            CWD: targetPath,
            SKILLS_PATH: skillsPath
        }
    });
}

export const getMcpClient = async (config: AgentConfig, skillsPath: string, serverPath: string, targetPath: string) => {

    const client = new Client({ name: "ai-app-doctor", version: "1.0.0" }, { capabilities: {} });
    try {
        await client.connect(getClientTransport(serverPath, targetPath, skillsPath, config.projectRootMode));
        logger.info(chalk.green("🟢 MCP Server online."));
    } catch (err: any) {
        logger.error(chalk.red(`❌ Connection Failed: ${err.message}`));
        return { success: false, report: "MCP Connection Failed" };
    }
    return client;
};