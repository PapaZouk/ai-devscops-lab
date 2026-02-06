import chalk from "chalk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollbackToSafety } from "./helpers/rollbackToSafety.js";

async function main() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Ensure this path correctly points to your target app
    const API_ROOT = path.resolve(__dirname, "../../vulnerable-api-app");

    console.log(chalk.blue.bold("\n🚀 Starting AI Safety Remediation Agent..."));

    try {
        const finalReport = await runSmartRemediator(
            "src/services/authService.ts",
            "Insecure JWT signing and hardcoded secrets.",
            API_ROOT
        );

        console.log(chalk.whiteBright("\n--- FINAL AGENT REPORT ---"));
        console.log(finalReport);
        console.log(chalk.whiteBright("---------------------------\n"));

        // Refined success check based on the return values in our new agent
        const reportText = finalReport ?? "";

        const isSuccessful =
            reportText.includes("fixed and verified") ||
            reportText.toLowerCase().includes("success");
        if (isSuccessful) {
            console.log(chalk.green.bold("🎉 Remediation Successful! Changes are live."));
        } else {
            console.log(chalk.yellow("⚠️ Agent finished without a verified fix."));
            // 🚩 Fix: Pass API_ROOT here
            await rollbackToSafety(API_ROOT);
        }
    } catch (error) {
        console.error(chalk.red("💥 Agent crashed unexpectedly:"), error);
        // 🚩 Fix: Pass API_ROOT here
        await rollbackToSafety(API_ROOT);
    }
}

main();