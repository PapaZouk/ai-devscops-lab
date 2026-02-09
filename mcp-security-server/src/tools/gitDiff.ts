import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "@logtape/logtape";
import chalk from "chalk";

const execPromise = promisify(exec);
const logger = getLogger("gitDiff");

export async function handleGitDiff(
    projectRoot: string
) {
    logger.info(chalk.blue.bold(`Generating git diff for project root.`));

    try {
        const { stdout, stderr } = await execPromise("git diff --no-color", {
            cwd: projectRoot,
            timeout: 10000,
        });

        const output = stdout || stderr;

        if (!output) {
            return {
                content: [{
                    type: "text" as const,
                    text: "No unstaged changes detected. The workbench matches the last commit."
                }],
                isError: false
            };
        }

        return {
            content: [{
                type: "text" as const,
                text: output
            }],
            isError: false
        };
    } catch (error: any) {
        if (error.message.includes("not a git repository")) {
            logger.warn(chalk.yellow("Target directory is not a git repository."));
            return {
                content: [{
                    type: "text" as const,
                    text: "Notice: The target project is not a git repository. Cannot provide a diff."
                }],
                isError: false
            };
        }

        logger.error(chalk.red.bold(`Error in gitDiff: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Failed to generate diff: ${error.message}`);
    }
}