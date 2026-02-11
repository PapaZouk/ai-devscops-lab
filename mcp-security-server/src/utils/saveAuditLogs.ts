import db from "./db.js";

export async function saveAuditLog(projectRoot: string, command: string, status: string, output: string) {
    const stmt = db.prepare(`
        INSERT INTO audit_logs (file_path, action, status, biome_output) 
        VALUES (?, ?, ?, ?)
    `);
    stmt.run("SYSTEM", `EXEC: ${command}`, status, output);
}