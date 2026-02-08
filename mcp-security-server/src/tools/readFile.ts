import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";
import path from "path";
import fs from "fs/promises";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("readFile");

export async function handleReadFile(
    projectRoot: string,
    args: { path: string }
) {
    const { path: relativePath } = args;
    const fullPath = path.resolve(projectRoot, relativePath);
    logger.info(chalk.blue.bold(`Starting readFile for: ${relativePath}`));

    if (!fullPath.startsWith(projectRoot)) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED readFile for: ${relativePath} (outside project root)`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ ACCESS DENIED: Cannot read files outside the project root."
        )
    }

    if (
        relativePath.includes("node_modules") ||
        relativePath.includes(".git") ||
        relativePath.includes(".env") ||
        relativePath.includes("security_audit.db")
    ) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED readFile for: ${relativePath} (restricted path)`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ ACCESS DENIED: Reading from this path is not allowed."
        );
    }

    try {
        const content = await fs.readFile(fullPath, "utf-8");

        return {
            content: [{
                type: "text" as const,
                text: content
            }],
            isError: false
        };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${relativePath} does not exist.`);
        }
        logger.error(chalk.red.bold(`Error in readFile for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to read file: ${error.message}`);
    }
}