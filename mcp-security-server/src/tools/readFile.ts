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
    const { path: requestedPath } = args;
    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";

    let physicalPath: string;

    // 1. Intercept Virtual Skills Path
    if (requestedPath.startsWith("./skills") || requestedPath.startsWith("skills")) {
        if (!skillsPath) {
            throw new McpError(ErrorCode.InvalidParams, "Skills library path not configured.");
        }
        const relativePart = requestedPath.replace(/^(\.\/)?skills/, "");
        physicalPath = path.resolve(skillsPath, relativePart.startsWith("/") ? relativePart.slice(1) : relativePart);
    } else {
        physicalPath = path.resolve(projectRoot, requestedPath);
    }

    logger.info(chalk.blue.bold(`📖 Reading file: ${requestedPath} (Physical: ${physicalPath})`));

    // 2. Boundary and Restriction Checks
    const resolvedProjectRoot = path.resolve(projectRoot);
    const resolvedSkillsPath = skillsPath ? path.resolve(skillsPath) : "";

    const isInsideProject = physicalPath.startsWith(resolvedProjectRoot);
    const isInsideSkills = resolvedSkillsPath && physicalPath.startsWith(resolvedSkillsPath);

    if (!isInsideProject && !isInsideSkills) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED: ${physicalPath} is outside allowed boundaries.`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Path outside project and skills library.");
    }

    if (
        requestedPath.includes("node_modules") ||
        requestedPath.includes(".git") ||
        requestedPath.includes(".env")
    ) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED restricted path: ${requestedPath}`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Restricted file type.");
    }

    // 3. Execution
    try {
        const content = await fs.readFile(physicalPath, "utf-8");
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