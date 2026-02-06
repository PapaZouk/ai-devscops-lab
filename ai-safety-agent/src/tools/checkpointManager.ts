import fs from 'fs/promises';
import path from 'path';

export async function checkpointManager(action: 'save' | 'load', filePath: string, content?: string): Promise<string> {
    const checkpointPath = path.resolve('./agent_knowledge/checkpoints', `${path.basename(filePath)}.checkpoint`);

    await fs.mkdir(path.dirname(checkpointPath), { recursive: true });

    if (action === 'save' && content) {
        await fs.writeFile(checkpointPath, content, 'utf8');
        return `SUCCESS: Checkpoint saved for ${filePath}. You can revert to this version if future modifications are rejected.`;
    }

    if (action === 'load') {
        try {
            const data = await fs.readFile(checkpointPath, 'utf8');
            return `CHECKPOINT_LOADED [${filePath}]:\n\n${data}`;
        } catch {
            return `ERROR: No checkpoint found for ${filePath}.`;
        }
    }
    return "INVALID_ACTION";
}