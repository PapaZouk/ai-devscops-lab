import chalk from "chalk";
import OpenAI from "openai";
import * as fs from "fs/promises";
import z from "zod";
import { zodToJsonSchema } from "openai/_vendor/zod-to-json-schema/index.js";
import path from "node:path";
import { configDotenv } from "dotenv";

configDotenv();

const lmStudio = new OpenAI({
    baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
    apiKey: "not-needed",
});

const FixResultSchema = z.object({
    analysis: z.string().optional().default("No analysis."),
    explanationOfChanges: z.string().optional().default("Fixing imports/syntax."),
    fixedCode: z.string(),
    confidencyScore: z.number().optional().default(1),      
});

export async function attemptSurgicalFix(targetFile: string, testError: string) {
    console.log(chalk.magenta.bold(`\n🛠  Attempting surgical fix for ${path.basename(targetFile)}...`));

    const originalCode = await fs.readFile(targetFile, 'utf-8');
    const rawSchema = zodToJsonSchema((FixResultSchema as any), "FixResult");

    // CRITICAL: Keep the prompt tiny for 4b models
    const prompt = `Fix this Node.js file to pass tests after a library update. 
    Return a JSON object with a "fixedCode" key containing the ENTIRE file content.
    
    ERROR: ${testError.substring(0, 300)}
    SOURCE: ${originalCode}`;

    try {
        const response = await lmStudio.chat.completions.create({
            model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
            messages: [
                { role: "system", content: "You are a JSON-only response bot. No prose." },
                { role: "user", content: prompt }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'fix', strict: false, schema: rawSchema },
            },
            temperature: 0,
            max_tokens: 4096, // CRITICAL: Ensure this is not set to a low number in LM Studio
        });

        const rawResponse = response.choices[0]?.message?.content?.trim() || "";
        
        console.log(chalk.magenta("\n--- [RAW AI RESPONSE] ---"));
        console.log(rawResponse);
        console.log(chalk.magenta("-------------------------\n"));

        let parsed;
        // Logic to handle if the AI sends raw code instead of JSON
        if (!rawResponse.startsWith("{")) {
            console.log(chalk.yellow("AI ignored JSON format, extracting raw text..."));
            parsed = { fixedCode: rawResponse };
        } else {
            const data = JSON.parse(rawResponse);
            parsed = data.fix || data;
        }

        const result = FixResultSchema.parse(parsed);

        if (result.fixedCode.length < 20) {
            throw new Error("AI returned truncated code.");
        }

        await fs.writeFile(`${targetFile}.bak`, originalCode);
        await fs.writeFile(targetFile, result.fixedCode, "utf-8");
        
        console.log(chalk.green.bold(`✅ Fix applied.`));
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
        console.log(chalk.yellow(`Restored ${path.basename(targetFile)}`));
    } catch (e) {}
}