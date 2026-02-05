import path from "path";
import fs from "fs/promises";
import * as fsSync from "fs";

export async function getKnowledgeBase(query: string): Promise<string> {
    const kbPath = path.resolve(__dirname, '../agent_knowledge/remediation_examples.json');
    const library: Record<string, any> = {
        jwt: { title: "JWT Security", code: "import jwt from 'jsonwebtoken';\nconst token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256' });" },
        zod: { title: "Zod Validation", code: "import { z } from 'zod';\nconst schema = z.object({ email: z.string().email() });" },
        env: { title: "Env Vars", code: "const secret = process.env.JWT_SECRET; // Never hardcode defaults" }
    };

    if (!fsSync.existsSync(kbPath)) {
        const key = Object.keys(library).find(k => query.toLowerCase().includes(k));
        return key ? `[REFERENCE] ${library[key].code}` : "Use process.env and standard ESM imports.";
    }

    const data = JSON.parse(await fs.readFile(kbPath, 'utf8'));
    const normalizedQuery = query.toLowerCase();
    const key = Object.keys(data).find(k => normalizedQuery.includes(k) || k.includes(normalizedQuery));
    return key ? `[REFERENCE: ${data[key].title}]\n${data[key].description}\n\nCODE:\n${data[key].code}` : "No specific match. Use standard ESM.";
}