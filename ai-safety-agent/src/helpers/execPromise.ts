import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

/**
 * Executes shell commands within the project context.
 */
async function execPromise(command: string, options: { cwd: string }) {
    const { stdout, stderr } = await execAsync(command, options);
    return { stdout, stderr };
}

export { execPromise };