import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import db from "../utils/db.js";
import chalk from "chalk";
import { getLogger } from "@logtape/logtape";

const BIOME_SUPPORTED_EXTENSIONS = new Set([
    ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".jsonc"
]);

const logger = getLogger("secureWrite");

export async function handleSecureWrite(
    projectRoot: string,
    args: { path: string; code: string; isTest?: boolean } // Made isTest optional for flexibility
) {
    const { path: relativePath, code, isTest = false } = args;
    const fullPath = path.resolve(projectRoot, relativePath);

    // 1. Security Guardrail: Path Traversal Prevention
    if (!fullPath.startsWith(path.resolve(projectRoot))) {
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Attempted to write outside project root.");
    }

    // 2. Policy Guardrail: Test Location Enforcement
    if (isTest && !relativePath.startsWith("tests/")) {
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Test files must be in 'tests/' directory.");
    }

    logger.info(chalk.blue.bold(`Starting secureWrite for: ${relativePath}`));

    try {
        // 3. File Operations
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, code, "utf-8");

        let status = 'SUCCESS';
        let biomeOutput = 'Linting skipped (unsupported file type)';
        const extension = path.extname(fullPath).toLowerCase();

        // 4. Expert Step: Conditional Linting
        if (BIOME_SUPPORTED_EXTENSIONS.has(extension)) {
            try {
                logger.info(chalk.gray(`Linting with Biome: ${relativePath}`));
                execSync(`npx @biomejs/biome check --write --files-ignore-unknown=true "${fullPath}"`, {
                    cwd: projectRoot,
                    stdio: 'pipe'
                });
                logger.info(chalk.green.bold(`✅ Biome linting passed for: ${relativePath}`));
                biomeOutput = 'SUCCESS';
            } catch (biomeError: any) {
                status = 'LINT_ERROR';
                biomeOutput = biomeError.stdout?.toString() || biomeError.message;

                // Return descriptive error so the AI can fix the syntax
                return {
                    content: [{
                        type: "text",
                        text: `✅ FILE SAVED, but Biome formatting failed. Review syntax.\nError: ${biomeOutput}`
                    }],
                    isError: false // We return false here so the agent can see the error but continue
                };
            }
        } else {
            logger.info(chalk.magenta(`ℹ️ Skipping Biome for ${extension} file: ${relativePath}`));
        }

        // 5. Audit Logging (Using your exact DB structure)
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(relativePath, isTest ? "WRITE_TEST" : "WRITE_SRC", status, biomeOutput);

        return {
            content: [{
                type: "text",
                text: status === 'SUCCESS'
                    ? `✅ SUCCESS: ${relativePath} written.${BIOME_SUPPORTED_EXTENSIONS.has(extension) ? ' (Linted)' : ' (Linting skipped)'}`
                    : `⚠️ LINT_ERROR: ${relativePath} written, but Biome found issues.`
            }],
            isError: false
        };
    } catch (error: any) {
        logger.error(chalk.red.bold(`Error in secureWrite for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to write file: ${error.message}`);
    }
}