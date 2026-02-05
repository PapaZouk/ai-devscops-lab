import path from "path";
import fs from "fs/promises";
import * as fsSync from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function getKnowledgeBase(query: string): Promise<string> {
    const kbPath = path.resolve(__dirname, '../../agent_knowledge/remediation_examples.json');

    if (!fsSync.existsSync(kbPath)) {
        return `ERROR: Knowledge base file not found at: ${kbPath}`;
    }

    try {
        const fileContent = await fs.readFile(kbPath, 'utf8');
        const data = JSON.parse(fileContent);
        const normalizedQuery = (query || "").toLowerCase().trim();

        let key = Object.keys(data).find(k =>
            normalizedQuery.includes(k.toLowerCase()) ||
            k.toLowerCase().includes(normalizedQuery)
        );

        if (!key) {
            key = Object.keys(data).find(k =>
                data[k].title.toLowerCase().includes(normalizedQuery) ||
                data[k].description.toLowerCase().includes(normalizedQuery)
            );
        }

        if (key) {
            const entry = data[key];
            return `[KNOWLEDGE FOUND: ${entry.title}]\nKey: ${key}\nDescription: ${entry.description}\n\nRecommended Implementation:\n${entry.code}`;
        }

        // 3. CRITICAL: If still no match, show the agent what IS available
        const availableTopics = Object.keys(data).join(", ");
        return `No specific match found for "${query}". \n\nAVAILABLE KNOWLEDGE KEYS: ${availableTopics}. \n\nPlease query one of these specific keys for implementation details.`;
    } catch (err: any) {
        return `ERROR: Failed to parse knowledge base: ${err.message}`;
    }
}