import chalk from "chalk";
import OpenAI from "openai";
import * as fs from "fs/promises";
import z from "zod";
import { zodToJsonSchema } from "openai/_vendor/zod-to-json-schema/zodToJsonSchema.js";
import path from "path/win32";

const lmStudio = new OpenAI({
    baseURL: process.env.LMSTUDIO_BASE_URL || "",
    apiKey: process.env.LMSTUDIO_API_KEY || "",
});

const FixResultSchema = z.object({
    analysis: z.string(),
    explanationOfChanges: z.string(),
    fixedCode: z.string(),
    confidencyScore: z.number().min(0).max(1),      
});

export async function attemptSurgicalFix(targetFile: string, testError: string) {
    console.log(chalk.magenta.bold(`Attempting surgical fix for ${targetFile}...`));

    const originalCode = await fs.readFile(targetFile, 'utf-8');

    const rawSchema = zodToJsonSchema((FixResultSchema as any), "FixResult");

    const prompt = `
        ROLE: Expert DevSecOps Engineer.
        CONTEXT: An automated security update has changed one or more dependencies in this Node.js project. 
        The file below is now failing its tests.

        GOAL: Adjust the syntax to be compatible with the current environment and library versions.

        STRICT CONSTRAINTS:
        1. PRESERVE BUSINESS LOGIC: Do not modify algorithms, secret keys, variable values, or conditional flows.
        2. MINIMAL INVASION: Only change the lines necessary to fix the error (usually imports or API calls).
        3. ENVIRONMENT HARMONIZATION: Correct any hallucinated or invalid imports based on standard NPM conventions.
        4. NO EXPLANATIONS: Return only the corrected source code. No markdown formatting.

        ERROR LOG:
        ${testError}

        ORIGINAL SOURCE CODE:
        ${originalCode}
    `;

    const response = await lmStudio.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
        messages: [
            { role: "system", content: "You are a helpful DevSecOps assistant." },
            { role: "user", content: prompt }
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'fix_result',
                strict: true,
                schema: rawSchema,
            },
        },
        temperature: 0.1,
    });

    try {
        const rawResponse = response.choices[0]?.message?.content?.trim() || "";
        const result = FixResultSchema.parse(JSON.parse(rawResponse));

        console.log(chalk.cyan("AI Analysis:"));
        console.log(chalk.gray(result.analysis));
        console.log(chalk.cyan("Explanation of Changes:"));
        console.log(chalk.gray(result.explanationOfChanges));
        console.log(chalk.cyan(`Confidency Score: ${result.confidencyScore}`));

        if (result.confidencyScore < 0.5) {
            console.log(chalk.red("Confidency score too low, aborting fix."));
        }

        if (result.fixedCode.length < 10) {   
            console.log(chalk.red("Fixed code too short, aborting fix."));
            throw new Error("AI returned empty code block");
        }

        await fs.writeFile(`${targetFile}.bak`, originalCode);
        await fs.writeFile(targetFile, result.fixedCode, "utf-8");
        console.log(chalk.green.bold(`Surgical fix applied to ${targetFile} successfully.`));
        return true;
    } catch (error) {
        console.error(chalk.red("Failed to apply surgical fix:"), error);
        return false
    }
}

export async function rollbackFile(targetFile: string) {
    const backupPath = `${targetFile}.bak`;
    try {
        const content = await fs.readFile(backupPath, "utf-8");
        await fs.writeFile(targetFile, content, "utf-8");
        await fs.unlink(backupPath);
        console.log(chalk.yellow(`Restored ${path.basename(targetFile)}`));
    } catch (e) { /* no backup found */ }
}