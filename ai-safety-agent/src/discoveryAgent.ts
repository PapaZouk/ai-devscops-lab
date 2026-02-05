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

    // DYNAMIC: Find all directories and files, excluding hidden folders and node_modules
    // We limit depth to 4 to keep the context window clean but catch most structures
    const fileTree = execSync(
        'find . -maxdepth 4 -not -path "*/.*" -not -path "./node_modules*" -type f',
        { cwd: apiRoot }
    ).toString();

    const response = await client.chat.completions.create({
        model: 'google/gemma-3-4b',
        messages: [
            {
                role: 'system',
                content: `You are a Project Architect. Your task is to analyze a file list and identify the project's "Functional Modules". 
                
                OBJECTIVE:
                Group related files (logic, data access, and tests) into logical modules. 
                
                RULES:
                1. Do not assume directory names like 'src' or 'tests'. Identify relationships by filename (e.g., 'authService', 'authRepo', 'auth.spec').
                2. Identify the core "Entry Point" or "Service" for the module.
                3. Identify the "Data Source" or "Repository" if applicable.
                4. Identify the "Test" file associated with the logic.
                5. Return ONLY a raw JSON object.

                REQUIRED JSON STRUCTURE:
                { 
                  "moduleName": { 
                    "logic": "relative/path/to/main/logic", 
                    "data": "relative/path/to/db/or/repo", 
                    "tests": "relative/path/to/test" 
                  } 
                }`
            },
            { role: 'user', content: `Analyze this project structure and map the modules: \n${fileTree}` }
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