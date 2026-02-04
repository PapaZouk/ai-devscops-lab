import chalk from "chalk";
import { configDotenv } from "dotenv";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";
import { zodToJsonSchema } from "openai/_vendor/zod-to-json-schema/index.js";
import z from "zod";

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
        console.log(chalk.green.bold("AI Remediation Strategy:"));
        console.log(chalk.green(JSON.stringify(strategy, null, 2)));

        applyPatch(strategy.commands);

        if (!checkIntegrity()) {
            console.error(chalk.red.bold("Remediation caused integrity issues. Please review the applied changes."));
            rollback();
        }
    } catch (error) {
        rollback();
        console.error(chalk.red("Failed to get AI remediation strategy:"), error);
        return;
    }

    console.log(chalk.green.bold("AI Remediation completed successfully."));
}

function applyPatch(commands: string[]) {
    console.log(chalk.blue.cyan.bold("Applying remediation commands..."));

    for (const cmd of commands) {
        console.log(chalk.gray(`Executing: ${cmd}`));
        try {
            const { stdout: executionOutput } = exec(cmd, { cwd: API_ROOT });
            if (executionOutput) console.log(chalk.green(cmd));
        } catch (error: any) {
            console.error(chalk.red(`Failed to execute command: ${cmd}`), error);
        }
    }

    console.log(chalk.blue.cyan.bold("Remediation commands applied."));
}

function checkIntegrity() {
    console.log(chalk.blue.cyan.bold("Checking integrity after remediation..."));

    try {
        const { stdout: testOutput } = exec(`npm run test`, { cwd: API_ROOT });
        console.log(chalk.green("Tests passed successfully."));
        return true;
    } catch (error: any) {
        console.error(chalk.red("Integrity check failed:"), error);
        return false;
    }
}

function rollback() {
    console.log(chalk.yellow.bold("Rolling back changes..."));
    try {
        const { stdout, stderr } = exec(`git reset --hard HEAD`, { cwd: API_ROOT });
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