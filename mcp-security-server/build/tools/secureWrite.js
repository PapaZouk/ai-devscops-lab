import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import fs from "fs/promises"; // Stick to promises exclusively
import path from "path";
import db from "../utils/db.js";
import chalk from "chalk";
export async function handleSecureWrite(projectRoot, args) {
    const { path: relativePath, code, isTest } = args;
    const fullPath = path.resolve(projectRoot, relativePath);
    if (isTest && !relativePath.startsWith("tests/")) {
        throw new McpError(ErrorCode.InvalidParams, "❌ REJECTED: Test files must be in 'tests/'");
    }
    console.log(chalk.blue.bold(`Starting secureWrite for: ${relativePath}`));
    try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, code, "utf-8");
        let status = 'SUCCESS';
        let biomeOutput = '';
        try {
            console.log(chalk.gray(`Linting with Biome: ${relativePath}`));
            execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: projectRoot });
            console.log(chalk.green.bold(`✅ Biome linting passed for: ${relativePath}`));
        }
        catch (biomeError) {
            console.error(chalk.yellow.bold(`⚠️ Biome linting issues for: ${relativePath}`));
            status = 'LINT_ERROR';
            biomeOutput = biomeError.stdout?.toString() || biomeError.message;
        }
        const stmt = db.prepare(`
            INSERT INTO audit_logs (file_path, action, status, biome_output) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(relativePath, isTest ? "WRITE_TEST" : "WRITE_SRC", status, biomeOutput);
        return {
            content: [{
                    type: "text",
                    text: status === 'SUCCESS'
                        ? `✅ SUCCESS: ${relativePath} written and linted.`
                        : `⚠️ LINT_ERROR: ${relativePath} written, but Biome found issues.`
                }],
            isError: status !== 'SUCCESS'
        };
    }
    catch (error) {
        console.error(chalk.red.bold(`Error in secureWrite for ${relativePath}: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to write file: ${error.message}`);
    }
}
//# sourceMappingURL=secureWrite.js.map