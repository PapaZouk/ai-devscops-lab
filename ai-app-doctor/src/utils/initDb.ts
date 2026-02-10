import Database from 'better-sqlite3';
import path from 'path';
import { pathToFileURL } from 'url';

export function initializeDatabase(dbPath: string) {
    const db = new Database(dbPath);

    // Create agent_memory table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS agent_memory (
            key TEXT PRIMARY KEY,
            value TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Audit logs table for secureWrite
    db.prepare(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            biome_output TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    db.close();
}

const argvPath = process.argv[1];
const isDirectRun =
    typeof argvPath === 'string' &&
    pathToFileURL(argvPath).href === import.meta.url;

if (isDirectRun) {
    const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
    const defaultPath = path.join(projectRoot, 'agent_state.db');
    initializeDatabase(defaultPath);
}
