import chalk from "chalk";
import { configDotenv } from "dotenv";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";
import z from "zod";
import fs from "node:fs/promises";
import { attemptSurgicalFix } from "./fixer.js";
import { getBiomeDiagnostics } from "./scanners/getBiomeDiagnostics.js";

configDotenv();

const execaAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "../../vulnerable-api-app");

// 🛡️ SECURITY: Strict Whitelist (Kept as requested)
const SafeCommandSchema = z.string().refine(
    (cmd) => cmd.startsWith("npm install") || cmd.startsWith("npm update") || cmd.startsWith("npm audit fix"),
    { message: "Only 'npm install', 'npm update', or 'npm audit fix' commands are allowed." }
);

const RemediationStrategy = z.object({
    reasoning: z.string().default("Security fix."),
    commands: z.preprocess((val) => {
        if (!Array.isArray(val)) return [];
        return val.map(item => {
            let cmd = typeof item === 'object' ? (item.command || item.cmd || Object.values(item)[0]) : String(item);
            
            // 🧹 SANITIZER: Strip markdown, backticks, and extra whitespace
            cmd = cmd.replace(/[`]/g, "").trim();
            
            // 🛠️ NORMALIZER: Convert "npm i" or "npm inst" to "npm install" to satisfy the Zod whitelist
            if (cmd.startsWith("npm i ") || cmd.startsWith("npm inst ")) {
                cmd = cmd.replace(/^npm i(nst)?/, "npm install");
            }
            return cmd;
        });
    }, z.array(SafeCommandSchema)),
    riskLevel: z.preprocess(
        (val) => String(val || "MEDIUM").toUpperCase().replace("MODERATE", "MEDIUM"),
        z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    ),
});

const lmStudio = new OpenAI({
    baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
    apiKey: "not-needed",
});

async function startAIRemidiation() {
    console.log(chalk.blue.bold("\n🚀 Starting AI Remediation Engine..."));

    try {
        const scanResult = await execaAsync(`npm run scan`).catch(err => err);
        const scanOutput = (scanResult.stdout || scanResult.message || "").substring(0, 2000);
        
        if (scanOutput.includes("No vulnerabilities found!")) {
            console.log(chalk.green.bold("✅ Environment is already secure."));
            return;
        }

        console.log(chalk.yellow("Consulting AI..."));
        
        const response = await lmStudio.chat.completions.create({
            model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
            messages: [
                { role: "system", content: "You are a DevSecOps bot. Return ONLY JSON." },
                { role: "user", content: `SCAN DATA:\n${scanOutput}\nReturn JSON.` }
            ],
            temperature: 0, 
        });
        
        const rawContent = response.choices[0]?.message?.content || "";
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI did not return JSON.");

        // 🛡️ VALIDATION: Parse + Sanitize + Validate
        const strategy = RemediationStrategy.parse(JSON.parse(jsonMatch[0]));
        console.log(chalk.green.bold("✔ Strategy accepted. Applying fixes..."));

        await applyPatch(strategy.commands);

        let integrity = await checkIntegrity();
        let attempts = 0;
        const MAX_ATTEMPTS = 5;

        while (!integrity.passed && attempts < MAX_ATTEMPTS) {
            attempts++;
            console.error(chalk.red.bold(`\n❌ Tests failed (Attempt ${attempts}/${MAX_ATTEMPTS}). Healing...`));
            
            const srcPath = path.resolve(API_ROOT, "src");
            const allFiles = await getAllFiles(srcPath);
            const targetFile = allFiles.find(f => integrity.lastTestError.includes(path.basename(f)));

            if (targetFile) {
                console.log(chalk.cyan(`🎯 Target: ${path.basename(targetFile)}`));
                const biomeIssues = await getBiomeDiagnostics(targetFile);
                
                // Try to fix
                const fixApplied = await attemptSurgicalFix(targetFile, integrity.lastTestError, biomeIssues);
                
                if (fixApplied) {
                    // Check again
                    integrity = await checkIntegrity();
                    if (integrity.passed) {
                        console.log(chalk.green.bold("✨ Tests passed! Code is now healthy."));
                        break; 
                    }
                }
            } else {
                console.log(chalk.yellow("Could not identify a specific failing file from logs."));
                break;
            }
        }

        if (!integrity.passed) {
            console.error(chalk.red.bold("\n🛑 Max attempts reached or unfixable error. Rolling back."));
            await rollback();
        } else {
            console.log(chalk.green.bold("\n🎉 Remediation successful! All tests green."));
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            console.error(chalk.red("\n❌ SECURITY ALERT: AI proposed an invalid plan."));
        } else {
            console.error(chalk.red("\nRemediation failed:"), error);
        }
        await rollback();
    }
}

async function applyPatch(commands: string[]) {
    for (const cmd of commands) {
        console.log(chalk.gray(`Executing: ${cmd}`));
        await execaAsync(cmd, { cwd: API_ROOT }).catch(() => {});
    }
}

async function checkIntegrity() {
    try {
        await execaAsync(`npm run test`, { cwd: API_ROOT });
        return { passed: true, lastTestError: "" };
    } catch (error: any) {
        return { passed: false, lastTestError: (error.stdout || "") + (error.stderr || "") };
    }
}

async function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        if (file.isDirectory()) await getAllFiles(filePath, arrayOfFiles);
        else if (file.name.endsWith(".ts")) arrayOfFiles.push(filePath);
    }
    return arrayOfFiles;
}

async function rollback() {
    console.log(chalk.yellow("Rolling back changes..."));
    await execaAsync(`git reset --hard HEAD`, { cwd: API_ROOT }).catch(() => {});
}

startAIRemidiation().catch(console.error);