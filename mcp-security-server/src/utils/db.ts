import Database from "better-sqlite3";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), "security_audit.db");
const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        biome_output TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

export default db;