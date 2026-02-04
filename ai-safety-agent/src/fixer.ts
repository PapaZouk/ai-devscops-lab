import chalk from "chalk";
import OpenAI from "openai";
import * as fs from "fs/promises";
import path from "node:path";
import { configDotenv } from "dotenv";

configDotenv();

const lmStudio = new OpenAI({
    baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
    apiKey: "not-needed",
});

/**
 * Attempts a surgical fix by asking the AI for a clean code block.
 * We've removed FixResultSchema and JSON_schema mode to prevent 4b model hallucinations.
 */
export async function attemptSurgicalFix(
    targetFile: string, 
    testError: string, 
    biomeIssues: any[] | null = null
) {
    console.log(chalk.magenta.bold(`\n🛠  Attempting surgical fix for ${path.basename(targetFile)}...`));

    const originalCode = await fs.readFile(targetFile, 'utf-8');

    // Format Biome issues for the prompt
    const linterHints = biomeIssues && biomeIssues.length > 0
        ? biomeIssues.map(i => `- [${i.code}]: ${i.message}`).join('\n')
        : "No static analysis issues found.";

    // Simplify the prompt: Markdown is more stable than JSON for 4b models
    const prompt = `
        ROLE: Expert DevSecOps Engineer.
        GOAL: Fix the Node.js file below to pass tests and resolve linter errors.

        TEST FAILURE:
        ${testError.substring(0, 400)}

        LINTER ERRORS:
        ${linterHints}

        SOURCE CODE TO FIX:
        ${originalCode}

        INSTRUCTIONS:
        1. Return ONLY the complete fixed source code.
        2. Wrap the code in a markdown block: \`\`\`typescript ... \`\`\`
        3. Do not provide explanations or prose.
    `;

    try {
        const response = await lmStudio.chat.completions.create({
            model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
            messages: [
                { role: "system", content: "You are a code-only assistant. Always respond with a single typescript markdown block." },
                { role: "user", content: prompt }
            ],
            // Removed response_format: { type: 'json_schema' } as it causes 4b models to crash
            temperature: 0.1, // Low temperature for stability
            max_tokens: 3000, 
        });

        const rawResponse = response.choices[0]?.message?.content?.trim() || "";
        
        console.log(chalk.magenta("\n--- [RAW AI RESPONSE] ---"));
        console.log(rawResponse);
        console.log(chalk.magenta("-------------------------\n"));

        // Use Regex to extract code from markdown block
        const codeMatch = rawResponse.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
        let fixedCode = codeMatch ? codeMatch[1].trim() : rawResponse.trim();

        // 4b Model Hallucination Cleaning: Remove any trailing backslashes or random JSON artifacts
        fixedCode = fixedCode.replace(/\\n/g, '\n').replace(/\\"/g, '"');

        // Validation: Did the AI return something substantial?
        if (fixedCode.length < originalCode.length * 0.3) {
            console.error(chalk.red("Validation failed: AI returned truncated code."));
            return false;
        }

        // Backup and write
        await fs.writeFile(`${targetFile}.bak`, originalCode);
        await fs.writeFile(targetFile, fixedCode, "utf-8");
        
        console.log(chalk.green.bold(`✅ Surgical fix applied to ${path.basename(targetFile)}.`));
        return true;

    } catch (error) {
        console.error(chalk.red("Surgical fix failed:"), error);
        return false;
    }
}

export async function rollbackFile(targetFile: string) {
    const backupPath = `${targetFile}.bak`;
    try {
        const content = await fs.readFile(backupPath, "utf-8");
        await fs.writeFile(targetFile, content, "utf-8");
        await fs.unlink(backupPath);
        console.log(chalk.yellow(`Restored ${path.basename(targetFile)} from backup.`));
    } catch (e) {
        // No backup exists, ignore
    }
}