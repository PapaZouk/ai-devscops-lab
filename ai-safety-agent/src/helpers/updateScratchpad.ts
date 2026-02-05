import path from "path";
import fs from "fs/promises";
import { ensureDir } from "./ensureDir.js";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

export async function updateScratchpad(content: string) {
    const memoryDir = path.resolve(projectRoot, '.agent_memory');
    await ensureDir(memoryDir);
    const scratchPath = path.resolve(memoryDir, 'scratchpad.md');
    const timestamp = new Date().toLocaleTimeString();

    let displayContent = content;
    if (content.includes("REJECTED") || content.includes("VALIDATION_FAILED") || content.includes("ERROR")) {
        displayContent = content.slice(0, 1500); // Give ample room for stack traces
    } else if (content.length > 500) {
        displayContent = content.slice(0, 500) + "... [TRUNCATED]";
    }

    const entry = `\n### [${timestamp}] LOG ENTRY\n${displayContent}\n---\n`;
    await fs.appendFile(scratchPath, entry, 'utf8');
}