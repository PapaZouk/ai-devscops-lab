import * as fs from 'fs';
import * as fsPromises from 'fs/promises';

export async function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) await fsPromises.mkdir(dirPath, { recursive: true });
}