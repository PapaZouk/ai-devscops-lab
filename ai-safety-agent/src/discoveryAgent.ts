import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureDir } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed'
});

export async function runDiscovery(apiRoot: string) {
    console.log("🔍 Discovery Agent: Mapping project architecture...");

    const knowledgeDir = path.resolve(agentRoot, 'agent_knowledge');
    const mapPath = path.resolve(knowledgeDir, 'api_map.json');
    await ensureDir(knowledgeDir);

    // 1. Expand search to include 'tests' and 'src'
    // This finds files in both src and tests directories
    const fileTree = execSync('find src tests -maxdepth 3 -not -path "*/.*" -type f', { cwd: apiRoot }).toString();

    // 2. Updated Prompt for better association
    const response = await client.chat.completions.create({
        model: 'google/gemma-3-4b',
        messages: [
            {
                role: 'system',
                content: `You are a Project Architect. Group related files into logical modules based on their functionality (e.g., "auth", "products").
                
                RULES:
                1. Look for matching names across directories (e.g., 'src/services/authService.ts' and 'tests/auth.test.ts' belong to "auth").
                2. If a module has no repository, leave it blank, but ALWAYS look for tests.
                3. Return ONLY raw JSON. No markdown blocks.

                Format: 
                { 
                  "moduleName": { 
                    "service": "path/to/service", 
                    "repository": "path/to/db", 
                    "tests": "path/to/test" 
                  } 
                }`
            },
            { role: 'user', content: `Map these files into functional modules: \n${fileTree}` }
        ],
    });

    let content = response.choices[0].message.content || '{}';
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        JSON.parse(content); // Validate before saving
        await fs.writeFile(mapPath, content, 'utf8');
        console.log("✅ API Map updated with tests.");
    } catch (e) {
        console.error("❌ LLM returned invalid JSON. Check logs.");
        // Optional: Save raw content for debugging
        await fs.writeFile(path.resolve(knowledgeDir, 'error_map.txt'), content);
    }
}