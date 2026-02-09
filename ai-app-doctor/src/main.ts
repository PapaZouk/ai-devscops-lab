import chalk from "chalk";
import path from "node:path";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";
import { startOrchestrator } from "./orchestrator.js"; // This is your new engine
import { SecurityAgent } from "./agents/security.js";
import { configDotenv } from "dotenv";

configDotenv();
const logger = getLogger("main");

async function main() {
    await setupLogger();

    const args = process.argv.slice(2);
    const agentArg = args.find((arg) => arg.startsWith("--agent="))?.split("=")[1];
    const targetArg = args.find((arg) => arg.startsWith("--target="))?.split("=")[1];
    const inputArg = args.find((arg) => arg.startsWith("--input="))?.split("=")[1];

    if (!agentArg || !targetArg) {
        console.error(chalk.red.bold("❌ Error: --agent and --target are required."));
        console.log("Example: npx tsx src/main.ts --agent=security --target=../repo --input='Fix bugs'");
        process.exit(1);
    }

    const agentMap: Record<string, any> = {
        security: SecurityAgent,
    };

    const selectedConfig = agentMap[agentArg.toLowerCase()];

    if (!selectedConfig) {
        logger.error(`Unknown agent type: ${agentArg}`);
        process.exit(1);
    }

    const absoluteTargetPath = path.resolve(process.cwd(), targetArg);
    const finalUserPrompt = inputArg || selectedConfig.defaultUserPrompt;

    console.log(chalk.bold.blue(`\n🤖 Launching ${selectedConfig.name}...`));
    console.log(chalk.gray(`📂 Target: ${absoluteTargetPath}`));

    try {
        const result = await startOrchestrator(selectedConfig, absoluteTargetPath, finalUserPrompt);

        if (result.success) {
            console.log(chalk.green.bold("\n✨ WORKFLOW COMPLETE ✨"));
            console.log(result.report);
            process.exit(0);
        } else {
            console.log(chalk.red.bold("\n❌ WORKFLOW FAILED"));
            console.error(result.report);
            process.exit(1);
        }
    } catch (err: any) {
        console.error(chalk.red.bold(`\n💥 Fatal Error: ${err.message}`));
        process.exit(1);
    }
}

main();