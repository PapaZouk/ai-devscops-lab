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
    args: { path: string; code: string; isTest?: boolean }
) {
    const { path: relativePath, code, isTest = false } = args;
    const fullPath = path.resolve(projectRoot, relativePath);

    if (!fullPath.startsWith(path.resolve(projectRoot))) {
        logger.warn(chalk.red(`⚠️ REJECTED: Attempted write outside root: ${relativePath}`));
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Cannot write outside project root.");
    }

    logger.info(chalk.blue.bold(`Starting secureWrite for: ${relativePath}`));

    try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, code, "utf-8");

        let status = 'SUCCESS';
        let biomeOutput = 'Linting skipped';
        const extension = path.extname(fullPath).toLowerCase();

        if (BIOME_SUPPORTED_EXTENSIONS.has(extension)) {
            try {
                execSync(`npx @biomejs/biome check --write --files-ignore-unknown=true "${fullPath}"`, {
                    cwd: projectRoot,
                    stdio: 'pipe'
                });
                biomeOutput = 'SUCCESS';
            } catch (biomeError: any) {
                status = 'LINT_ERROR';
                biomeOutput = biomeError.stdout?.toString() || biomeError.message;

                return {
                    content: [{
                        type: "text" as const,
                        text: `✅ FILE SAVED, but Biome formatting failed.\nError: ${biomeOutput}`
                    }],
                    isError: false
                };
            }
        }

        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(relativePath, isTest ? "WRITE_TEST" : "WRITE_SRC", status, biomeOutput);

        return {
            content: [{
                type: "text" as const,
                text: `✅ SUCCESS: ${relativePath} written.`
            }],
            isError: false
        };
    } catch (error: any) {
        logger.error(chalk.red.bold(`Error in secureWrite: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to write file: ${error.message}`);
    }
}