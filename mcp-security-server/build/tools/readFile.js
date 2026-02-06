import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";
import path from "path";
import fs from "fs/promises";
export async function handleReadFile(projectRoot, args) {
    const { path: relativePath } = args;
    const fullPath = path.resolve(projectRoot, relativePath);
    console.log(chalk.blue.bold(`Starting readFile for: ${relativePath}`));
    if (!fullPath.startsWith(projectRoot)) {
        console.log(chalk.yellow.bold(`⚠️ REJECTED readFile for: ${relativePath} (outside project root)`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Cannot read files outside the project root.");
    }
    if (relativePath.includes("node_modules") ||
        relativePath.includes(".git") ||
        relativePath.includes(".env") ||
        relativePath.includes("security_audit.db")) {
        console.log(chalk.yellow.bold(`⚠️ REJECTED readFile for: ${relativePath} (restricted path)`));
        throw new McpError(ErrorCode.InvalidParams, "❌ ACCESS DENIED: Reading from this path is not allowed.");
    }
    try {
        const content = await fs.readFile(fullPath, "utf-8");
        return {
            content: [{
                    type: "text",
                    text: content
                }],
            isError: false
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new McpError(ErrorCode.InvalidParams, `❌ FILE NOT FOUND: ${relativePath} does not exist.`);
        }
        console.error(chalk.red.bold(`Error in readFile for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to read file: ${error.message}`);
    }
}
//# sourceMappingURL=readFile.js.map