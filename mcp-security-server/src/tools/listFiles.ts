import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import fs from "fs/promises";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store']);
const logger = getLogger("listFiles");

/**
 * Internal helper to perform recursive scanning without re-triggering 
 * the path-swap logic or boundary checks multiple times.
 */
async function scanDirectory(physicalPath: string, virtualBase: string, recursive: boolean): Promise<any[]> {
    const entries = await fs.readdir(physicalPath, { withFileTypes: true });
    const results: any[] = [];

    for (const entry of entries) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;

        const isDirectory = entry.isDirectory();
        const entryVirtualPath = path.join(virtualBase, entry.name);
        const entryPhysicalPath = path.join(physicalPath, entry.name);

        results.push({
            name: entry.name,
            type: isDirectory ? 'directory' : 'file',
            path: entryVirtualPath
        });

        if (recursive && isDirectory) {
            const subResults = await scanDirectory(entryPhysicalPath, entryVirtualPath, true);
            results.push(...subResults);
        }
    }
    return results;
}

export async function handleListFiles(
    projectRoot: string,
    args: { path: string, recursive?: boolean }
) {
    const { path: requestedPath, recursive = false } = args;
    const skillsPath = process.env.SKILLS_PATH ? path.resolve(process.env.SKILLS_PATH) : "";

    let physicalPath: string;

    // 1. Determine Root (Project vs Skills)
    if (requestedPath.startsWith("./skills") || requestedPath.startsWith("skills")) {
        if (!skillsPath) {
            throw new McpError(ErrorCode.InvalidParams, "Skills library path (SKILLS_PATH) not configured.");
        }
        const relativePart = requestedPath.replace(/^(\.\/)?skills/, "");
        physicalPath = path.resolve(skillsPath, relativePart.startsWith("/") ? relativePart.slice(1) : relativePart);
    } else {
        physicalPath = path.resolve(projectRoot, requestedPath);
    }

    // 2. Security Boundary Check
    const resolvedProjectRoot = path.resolve(projectRoot);
    const resolvedSkillsPath = skillsPath ? path.resolve(skillsPath) : "";

    const isInsideProject = physicalPath.startsWith(resolvedProjectRoot);
    const isInsideSkills = resolvedSkillsPath && physicalPath.startsWith(resolvedSkillsPath);

    if (!isInsideProject && !isInsideSkills) {
        logger.warn(chalk.yellow.bold(`⚠️ REJECTED: ${physicalPath} is outside sandbox.`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Path outside allowed boundaries.");
    }

    // 3. Execution
    try {
        const result = await scanDirectory(physicalPath, requestedPath, recursive);

        logger.debug(chalk.green(`✅ listFiles successful: ${requestedPath}`));
        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify(result, null, 2)
            }]
        };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            throw new McpError(ErrorCode.InvalidParams, `❌ NOT FOUND: ${requestedPath}`);
        }
        throw new McpError(ErrorCode.InternalError, `Failed to list: ${error.message}`);
    }
}