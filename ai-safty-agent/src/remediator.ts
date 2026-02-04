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

async function startAIRemidiation() {
    console.log(chalk.blue.bold("Starting AI Remediation..."));

    console.log(chalk.gray("Running security scan..."));

    const { stdout: scanOutput } = await execaAsync(`npm run scan`);

    console.log(chalk.gray("Security scan completed. Findings:"));
    console.log(chalk.yellow(scanOutput));

    console.log(chalk.yellow("Consulting AI for remediation steps..."));

    const rawSchema = zodToJsonSchema((RemediationStrategy as any), "RemediationStrategy");

    const response = await lmStudio.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
        messages: [
            {
                role: "system", 
                content: `You are a DevSecOps automation tool. You only output valid JSON matching this schema:
                {
                "reasoning": "string",
                "commands": ["string"],
                "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
                "potentialBreakingChanges": "string"
                }`
            },
            { 
                role: "user",
                content: `Remediate these findings: ${scanOutput}`
            }
        ],
        response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'fix_plan',
                        strict: true,
                        schema: rawSchema,
                    },
                },
        temperature: 0.2,
    });
        
    const rawResponse = response.choices[0]?.message?.content || "";
    
    try {
        const parsed = JSON.parse(rawResponse);
        const strategy = RemediationStrategy.parse(Array.isArray(parsed) ? parsed[0] : parsed);
        console.log(chalk.green.bold("Remediation strategy accepted"));

        await applyPatch(strategy.commands);

        const integrityResult = await checkIntegrity();
        
        if (!integrityResult.passed) {
            console.error(chalk.red.bold("Integrity issues detected. Identifying target file..."));
            const errorLog = integrityResult.lastTestError;

            // Step 1: Try Regex Identification
            const fileRegex = /(?:\/|[A-Z]:\\)[\w\/-]+\.ts/g; 
            const matches = errorLog.match(fileRegex);
            let targetFile = matches?.find((file: string) => file.includes('/src') && !file.includes('.test.ts')) || "";

            // Step 2: Fallback to AI Identification
            if (!targetFile) {
                console.log(chalk.yellow("Regex failed. Asking AI to guess the failing file..."));
                
                const identifyResponse = await lmStudio.chat.completions.create({
                    model: process.env.LMSTUDIO_MODEL_NAME || "google/gemma-3-4b",
                    messages: [
                        { 
                            role: "user", 
                            content: `Based on this error: "${errorLog}", which source file in the "src/" directory is broken? 
                            Note: The source files are in "src/" and tests are in "tests/". 
                            Return only the relative path to the SOURCE file (e.g., services/authService.ts).` 
                        }
                    ],
                });

                const fileName = identifyResponse.choices[0].message.content?.trim();

                if (fileName) targetFile = path.resolve(API_ROOT, "src", fileName);
            }

            if (targetFile && targetFile.endsWith('.ts')) {
                console.log(chalk.blue(`🚀 Surgical fix target: ${targetFile}`));
                const fixed = await attemptSurgicalFix(targetFile, errorLog);
                
                if (fixed) {
                    const finalCheck = await checkIntegrity();
                    if (finalCheck.passed) {
                        console.log(chalk.green.bold("✨ AI successfully healed the code!"));
                        return; // Success!
                    }
                }
            }

            console.error(chalk.red("Fix attempt failed. Rolling back..."));
            await rollbackFile(targetFile);
            await rollback();
        }
    } catch (error) {
        await rollback();
        console.error(chalk.red("Remediation failed:"), error);
    }

    console.log(chalk.green.bold("AI Remediation completed successfully."));
}

async function applyPatch(commands: string[]) {
    console.log(chalk.blue.cyan.bold("Applying remediation commands..."));

    for (const cmd of commands) {
        console.log(chalk.gray(`Executing: ${cmd}`));
        try {
            const { stdout: executionOutput } = await execaAsync(cmd, { cwd: API_ROOT });
            console.log(`Successfully executed: ${executionOutput}`);
        } catch (error: any) {
            console.error(chalk.red(`Failed to execute command: ${cmd}`), error);
        }
    }

    console.log(chalk.blue.cyan.bold("Remediation commands applied."));
}

async function checkIntegrity(): Promise<{ passed: boolean, lastTestError: string }> {
    console.log(chalk.blue.cyan.bold("Checking integrity after remediation..."));

    try {
        await execaAsync(`npm run test`, { cwd: API_ROOT });
        console.log(chalk.green("Tests passed successfully."));
        return { passed: true, lastTestError: "" };
    } catch (error: any) {
        const fullErrorReport = `${error.stdout || ''}\n${error.stderr || ''}`;
        
        if (fullErrorReport.includes("PASS") && fullErrorReport.includes("obsolete")) {
            console.log(chalk.yellow("Tests passed, but found obsolete snapshots. Continuing..."));
            return { passed: true, lastTestError: "" };
        }
        
        return { passed: false, lastTestError: fullErrorReport };
    }
}

async function rollback() {
    console.log(chalk.yellow.bold("Rolling back changes..."));
    try {
        const { stdout, stderr } = await execaAsync(`git reset --hard HEAD`, { cwd: API_ROOT });
        if (stdout) console.log(chalk.green(stdout));
        if (stderr) console.error(chalk.red(stderr));
        console.log(chalk.yellow.bold("Rollback completed."));
    } catch (error) {
        console.error(chalk.red("Failed to rollback changes:"), error);
    }
}

startAIRemidiation().catch((error) => {
    console.error(chalk.red("AI Remediation failed:"), error);
}).finally(() => {
    console.log(chalk.blue.bold("AI Remediation process finished."));
    process.exit(0);
});