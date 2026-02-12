import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";
import path from "path";
import fs from "fs/promises";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("readFile");
const BLOCKED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const MAX_READ_BYTES = 64 * 1024;

export async function handleReadFile(
    projectRoot: string,
    args: { path?: string }
) {
    const requestedPath = args.path;

    if (!requestedPath) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: Missing 'path'. Provide a file path to read."
            }],
            isError: true
        };
    }
    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";
    const fullPath = path.resolve(projectRoot, requestedPath);

    logger.info(chalk.blue.bold(`Starting readFile for: ${requestedPath}`));

    const isInsideProject = fullPath.startsWith(path.resolve(projectRoot));
    const isInsideSkills = skillsPath && fullPath.startsWith(skillsPath);

    if (!isInsideProject && !isInsideSkills) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED: ${requestedPath} is outside allowed boundaries.`));
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ ACCESS DENIED: Path is outside project and skills library."
        );
    }

    if (
        requestedPath.includes("node_modules") ||
        requestedPath.includes(".git") ||
        requestedPath.includes(".env")
    ) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED restricted path: ${requestedPath}`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Restricted path.");
    }

    if (BLOCKED_FILES.has(path.basename(requestedPath))) {
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ ACCESS DENIED: Lockfiles cannot be read directly. Use run_command to inspect or regenerate dependency state."
        );
    }

    try {
        const stats = await fs.stat(fullPath);
        if (stats.size > MAX_READ_BYTES) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ FILE TOO LARGE: ${requestedPath} is ${stats.size} bytes. Use targeted reads or run_command to inspect it.`
            );
        }

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
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${requestedPath}`);
        }
        logger.error(chalk.red.bold(`Error in readFile: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to read file: ${error.message}`);
    }
}
