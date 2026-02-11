import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

export async function executeCommand(projectRoot: string, commandToExecute: string) {
    return execPromise(commandToExecute, {
        cwd: projectRoot,
        timeout: 60000,
        env: {
            ...process.env,
            PROJECT_ROOT: projectRoot,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
        }
    });
}