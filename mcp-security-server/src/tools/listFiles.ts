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
    const { path: relativePath, recursive = false } = args;
    const fullPath = path.resolve(projectRoot, relativePath);

    if (!fullPath.startsWith(projectRoot)) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED listFiles for: ${relativePath} (outside project root)`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Cannot read files outside the project root.");
    }

    try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });

        const result: any[] = [];

        for (const entry of entries) {
            if (IGNORED_DIRECTORIES.has(entry.name)) continue;

            const entryRelativePath = path.join(relativePath, entry.name);
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
                const parsed = JSON.parse(subFiles.content[0].json);
                result.push(...parsed);
            }
        }

        logger.debug(chalk.green(`✅ listFiles successful for: ${relativePath} (found ${result.length} entries)`));
        return {
            content: [{
                type: "json" as const,
                json: JSON.stringify(result, null, 2)
            }]
        };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            logger.warn(chalk.yellow.bold(`⚠️ REJECTED listFiles for: ${relativePath} (file not found)`));
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${relativePath} does not exist.`);
        }
        logger.error(chalk.red.bold(`Error in listFiles for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to list files: ${error.message}`);
    }
}