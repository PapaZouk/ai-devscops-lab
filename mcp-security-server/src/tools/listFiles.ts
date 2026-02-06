import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import fs from "fs/promises";

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store']);

export async function handleListFiles(
    projectRoot: string,
    args: { path: string, recursive?: boolean }
) {
    const { path: relativePath, recursive = false } = args;
    const fullPath = path.resolve(projectRoot, relativePath);

    if (!fullPath.startsWith(projectRoot)) {
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
                // Parse and merge results from sub-call
                const parsed = JSON.parse(subFiles.content[0].json);
                result.push(...parsed);
            }
        }
        return {
            content: [{
                type: "json" as const,
                json: JSON.stringify(result, null, 2)
            }]
        };
    } catch (error: any) {
        if (error.code === "ENOENT") {
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${relativePath} does not exist.`);
        }
        throw new McpError(ErrorCode.InvalidParams, `❌ ERROR: ${error.message}`);
    }
}