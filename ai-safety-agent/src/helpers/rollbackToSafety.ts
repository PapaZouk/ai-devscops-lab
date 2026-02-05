import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import fsSync from 'fs';
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

export async function rollbackToSafety(apiRoot: string) {
    const memoryDir = path.resolve(projectRoot, '.agent_memory');
    try {
        if (fsSync.existsSync(memoryDir)) await fs.promises.rm(memoryDir, { recursive: true, force: true });
        execSync('git reset --hard HEAD', { cwd: apiRoot, stdio: 'ignore' });
        execSync('git clean -fd', { cwd: apiRoot, stdio: 'ignore' });
    } catch (err) { }
}