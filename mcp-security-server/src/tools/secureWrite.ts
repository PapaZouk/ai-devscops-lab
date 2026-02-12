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
const BLOCKED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const MAX_WRITE_CHARS = 120_000;

const logger = getLogger("secureWrite");

export async function handleSecureWrite(
    projectRoot: string,
    args: { path: string; code?: string; content?: string; isTest?: boolean }
) {
    const { path: relativePath, code, content, isTest = false } = args;
    const finalCode = code ?? content;

    if (finalCode === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "❌ No code or content provided to write.");
    }

    const fullPath = path.resolve(projectRoot, relativePath);
    const baseName = path.basename(relativePath);

    if (!fullPath.startsWith(path.resolve(projectRoot))) {
        logger.warn(chalk.red(`⚠️ REJECTED: Attempted write outside root: ${relativePath}`));
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Cannot write outside project root.");
    }

    if (BLOCKED_FILES.has(baseName)) {
        throw new McpError(
            ErrorCode.InvalidParams,
            "❌ REJECTED: Do not write lockfiles directly. Update package.json and use run_command to regenerate lockfiles."
        );
    }

    if (finalCode.length > MAX_WRITE_CHARS) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `❌ REJECTED: Write payload too large (${finalCode.length} chars). Use focused edits instead of full-file rewrites.`
        );
    }

    logger.info(chalk.blue.bold(`Starting secureWrite for: ${relativePath}`));

    try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, finalCode, "utf-8");

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
