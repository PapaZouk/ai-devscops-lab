import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");

const baseDir = process.env.PROJECT_ROOT || DEFAULT_ROOT;
const dbPath = path.join(baseDir, 'agent_state.db');

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

export default db;