import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import db from "../utils/db.js";
import chalk from "chalk";

/**
 * List of extensions currently supported by Biome.
 * Biome will throw an error if called on an unsupported file (like .env).
 */
const BIOME_SUPPORTED_EXTENSIONS = new Set([
    ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".jsonc"
]);

export async function handleSecureWrite(
    projectRoot: string,
    args: { path: string; code: string; isTest: boolean }
) {
    const { path: relativePath, code, isTest } = args;
    const fullPath = path.resolve(projectRoot, relativePath);

    // Security Guard: Prevent writing outside the project root
    if (!fullPath.startsWith(path.resolve(projectRoot))) {
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Attempted to write outside project root.");
    }

    if (isTest && !relativePath.startsWith("tests/")) {
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Test files must be in 'tests/'");
    }

    console.log(chalk.blue.bold(`Starting secureWrite for: ${relativePath}`));

    try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        // Write the file
        await fs.writeFile(fullPath, code, "utf-8");

        let status = 'SUCCESS';
        let biomeOutput = 'Linting skipped (unsupported file type)';

        const extension = path.extname(fullPath).toLowerCase();

        // Only run Biome if the file extension is supported
        if (BIOME_SUPPORTED_EXTENSIONS.has(extension)) {
            try {
                console.log(chalk.gray(`Linting with Biome: ${relativePath}`));
                // Use --files-ignore-unknown=true as a secondary safety measure
                execSync(`npx @biomejs/biome check --write --files-ignore-unknown=true "${fullPath}"`, {
                    cwd: projectRoot,
                    stdio: 'pipe'
                });
                console.log(chalk.green.bold(`✅ Biome linting passed for: ${relativePath}`));
                biomeOutput = 'SUCCESS';
            } catch (biomeError: any) {
                status = 'LINT_ERROR';
                return {
                    content: [{
                        type: "text",
                        text: `✅ FILE SAVED, but Biome formatting failed. Do not try to re-write the same file. Error: ${biomeError.message}`
                    }],
                    isError: false // CHANGE THIS TO FALSE
                };
            }
        } else {
            console.log(chalk.magenta(`ℹ️ Skipping Biome for ${extension} file: ${relativePath}`));
        }

        // Log to Audit Database
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(relativePath, isTest ? "WRITE_TEST" : "WRITE_SRC", status, biomeOutput);

        return {
            content: [{
                type: "text" as const,
                text: status === 'SUCCESS'
                    ? `✅ SUCCESS: ${relativePath} written.${BIOME_SUPPORTED_EXTENSIONS.has(extension) ? ' (Linted)' : ' (Linting skipped)'}`
                    : `⚠️ LINT_ERROR: ${relativePath} written, but Biome found issues.`
            }],
            isError: status !== 'SUCCESS'
        };
    } catch (error: any) {
        console.error(chalk.red.bold(`Error in secureWrite for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to write file: ${error.message}`);
    }
}