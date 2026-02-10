import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

export async function handleGitStatus(projectRoot: string) {
    try {
        const { stdout } = await execPromise("git branch --show-current", { cwd: projectRoot });
        const branch = stdout.trim();

        const { stdout: status } = await execPromise("git status --short", { cwd: projectRoot });

        return {
            content: [{
                type: "text" as const,
                text: `Current Branch: ${branch}\nChanges:\n${status || "Clean workbench"}`
            }],
            isError: false
        };
    } catch (error: any) {
        return {
            content: [{ type: "text" as const, text: "Git not initialized or missing." }],
            isError: false
        };
    }
}