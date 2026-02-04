import chalk from "chalk";
import { configDotenv } from "dotenv";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";
import { zodToJsonSchema } from "openai/_vendor/zod-to-json-schema/index.js";
import z from "zod";
import { attemptSurgicalFix, rollbackFile } from "./fixer.js";
import fs from "node:fs/promises";

configDotenv();

const execaAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "../../vulnerable-api-app");

const SafeCommandSchema = z.string().refine(
    (cmd) => cmd.startsWith("npm install") || cmd.startsWith("npm update") || cmd.startsWith("npm audit fix"),
    {
        message: "Only 'npm install', 'npm update', or 'npm audit fix' commands are allowed.",
    }
);

const RemediationStrategy = z.object({
    reasoning: z.string(),
    commands: z.array(SafeCommandSchema),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    potentialBreakingChanges: z.string().optional(),
});

export type RemediationStrategy = z.infer<typeof RemediationStrategy>;

const lmStudio = new OpenAI({
    baseURL: process.env.LMSTUDIO_BASE_URL || "",
    apiKey: process.env.LMSTUDIO_API_KEY || "",
});

/**
 * Finds all .ts files in the src directory recursively
 */
async function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            await getAllFiles(filePath, arrayOfFiles);
        } else if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
            arrayOfFiles.push(filePath);
        }
    }
    return arrayOfFiles;
}

async function startAIRemidiation() {
    console.log(chalk.blue.bold("\n🚀 Starting AI Remediation Engine..."));

    // 1. SCAN
    console.log(chalk.gray("Running security scan..."));
    const { stdout: scanOutput } = await execaAsync(`npm run scan`);
    console.log(chalk.gray("Security scan completed. Findings:"));
    console.log(chalk.yellow(scanOutput));

    if (scanOutput.includes("No vulnerabilities found!")) {
        console.log(chalk.green.bold("✅ Environment is already secure. Nothing to fix."));
        return;
    }

    // 2. CONSULT AI
    console.log(chalk.yellow("Consulting AI for remediation steps..."));
    const rawSchema = zodToJsonSchema((RemediationStrategy as any), "RemediationStrategy");

    const response = await lmStudio.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
        messages: [
            {
                role: "system", 
                content: `STRICT JSON ONLY. Return a flat JSON object with these keys: "reasoning", "commands", "riskLevel". No markdown, no prose. riskLevel must be LOW, MEDIUM, HIGH, or CRITICAL.`
            },
            { role: "user", content: `Remediate: ${scanOutput}` }
        ],
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'fix_plan', strict: true, schema: rawSchema },
        },
        temperature: 0.1,
    });
        
    try {
        const rawResponse = response.choices[0]?.message?.content || "";
        
        // Log the raw response for debugging structured output issues
        console.log(chalk.magenta("\n--- [RAW AI RESPONSE] ---"));
        console.log(rawResponse);
        console.log(chalk.magenta("-------------------------\n"));

        // Extract JSON block using regex to avoid prose issues
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain a valid JSON object.");

        let parsed = JSON.parse(jsonMatch[0]);

        // --- FLATTENING LOGIC ---
        // If the AI wrapped our fields in a named property like "fix_plan", flatten it.
        if (parsed.fix_plan && typeof parsed.fix_plan === 'object') parsed = parsed.fix_plan;
        if (parsed.remediation && typeof parsed.remediation === 'object') parsed = parsed.remediation;
        if (Array.isArray(parsed)) parsed = parsed[0];

        // Ensure "commands" is an array
        if (parsed.commands && typeof parsed.commands === 'string') parsed.commands = [parsed.commands];

        // Validate with Zod
        const strategy = RemediationStrategy.parse(parsed);
        console.log(chalk.green.bold("✔ Remediation strategy accepted"));

        // 3. APPLY PATCH
        await applyPatch(strategy.commands);

        // 4. INTEGRITY CHECK
        const integrityResult = await checkIntegrity();
        
        if (!integrityResult.passed) {
            console.error(chalk.red.bold("\n❌ Integrity issues detected. Identifying failing file..."));
            const errorLog = integrityResult.lastTestError;

            // 5. IDENTIFY FAILING FILE
            const srcPath = path.resolve(API_ROOT, "src");
            const allSourceFiles = await getAllFiles(srcPath);

            let targetFile = allSourceFiles.find(filePath => {
                const fileName = path.basename(filePath);
                const fileNameNoExt = path.parse(filePath).name;
                return errorLog.includes(fileName) || errorLog.includes(fileNameNoExt);
            });

            // AI Fallback for identification
            if (!targetFile) {
                console.log(chalk.yellow("No direct file match. Asking AI to deduce culprit..."));
                const identifyResponse = await lmStudio.chat.completions.create({
                    model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
                    messages: [{ 
                        role: "user", 
                        content: `Failing logs: "${errorLog}". \nFiles: ${allSourceFiles.map(f => path.relative(API_ROOT, f)).join('\n')}\nIdentify the source file to fix. Return ONLY the relative path.` 
                    }],
                    temperature: 0,
                });
                const aiGuessedPath = identifyResponse.choices[0].message.content?.trim().replace(/[`"']/g, "") || "";
                const absoluteGuessedPath = path.resolve(API_ROOT, aiGuessedPath);
                if (allSourceFiles.includes(absoluteGuessedPath)) targetFile = absoluteGuessedPath;
            }

            // 6. SURGICAL FIX
            if (targetFile) {
                console.log(chalk.green(`🎯 Target: ${targetFile}`));
                const fixed = await attemptSurgicalFix(targetFile, errorLog);
                
                if (fixed) {
                    const finalCheck = await checkIntegrity();
                    if (finalCheck.passed) {
                        console.log(chalk.green.bold("✨ AI successfully healed the code!"));
                        return; 
                    }
                }
            } else {
                console.error(chalk.red("❌ Could not identify failing file."));
            }
            await rollback();
        }
    } catch (error) {
        console.error(chalk.red("\nCritical failure in remediation loop:"));
        console.error(error);
        await rollback();
    }
}

async function applyPatch(commands: string[]) {
    console.log(chalk.blue.cyan.bold("Applying remediation commands..."));
    for (const cmd of commands) {
        console.log(chalk.gray(`Executing: ${cmd}`));
        try {
            await execaAsync(cmd, { cwd: API_ROOT });
            console.log(chalk.green(`✔ Success: ${cmd}`));
        } catch (error: any) {
            console.error(chalk.red(`✘ Failed: ${cmd}`));
        }
    }
}

async function checkIntegrity(): Promise<{ passed: boolean, lastTestError: string }> {
    console.log(chalk.blue.cyan.bold("Checking integrity after remediation..."));
    try {
        await execaAsync(`npm run test`, { cwd: API_ROOT });
        console.log(chalk.green("✔ Tests passed."));
        return { passed: true, lastTestError: "" };
    } catch (error: any) {
        const diagnosticReport = [
            "--- STDOUT ---", error.stdout || "",
            "--- STDERR ---", error.stderr || "",
            "--- MESSAGE ---", error.message || ""
        ].join("\n");
        return { passed: false, lastTestError: diagnosticReport };
    }
}

async function rollback() {
    console.log(chalk.yellow.bold("Rolling back changes..."));
    try {
        await execaAsync(`git reset --hard HEAD`, { cwd: API_ROOT });
        console.log(chalk.yellow.bold("Rollback completed."));
    } catch (error) {
        console.error(chalk.red("Failed to rollback changes:"), error);
    }
}

startAIRemidiation().catch(console.error);