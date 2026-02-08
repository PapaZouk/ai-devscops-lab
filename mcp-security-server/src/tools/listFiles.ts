import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import fs from "fs/promises";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store']);
const logger = getLogger("listFiles");

export async function handleListFiles(
    projectRoot: string,
    args: { path: string, recursive?: boolean }
) {
    const { path: requestedPath, recursive = false } = args;
    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";
    const fullPath = path.resolve(projectRoot, requestedPath);

    const isInsideProject = fullPath.startsWith(path.resolve(projectRoot));
    const isInsideSkills = skillsPath && fullPath.startsWith(skillsPath);

    if (!isInsideProject && !isInsideSkills) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED listFiles: ${requestedPath} is outside allowed boundaries.`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Path outside project and skills library.");
    }

    try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const result: any[] = [];

        for (const entry of entries) {
            if (IGNORED_DIRECTORIES.has(entry.name)) continue;

            const entryRelativePath = path.join(requestedPath, entry.name);
            const isDirectory = entry.isDirectory();

            result.push({
                name: entry.name,
                type: isDirectory ? 'directory' : 'file',
                path: entryRelativePath
            });

            if (recursive && isDirectory) {
                const subFiles = await handleListFiles(projectRoot, {
                    path: entryRelativePath,
                    recursive: true
                });
                const parsed = JSON.parse(subFiles.content[0].text);
                result.push(...parsed);
            }
        }

        logger.debug(chalk.green(`✅ listFiles successful for: ${requestedPath}`));
        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify(result, null, 2)
            }]
        };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${requestedPath}`);
        }
        logger.error(chalk.red.bold(`Error in listFiles: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to list files: ${error.message}`);
    }
}