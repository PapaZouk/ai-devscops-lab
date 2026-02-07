import chalk from "chalk";
import { setupLogger } from "./config/setupLogger.js";
import { getLogger } from "@logtape/logtape";
import { startOrchestrator } from "./orchestrator.js";
import path from "node:path";
import { SecurityAgent } from "./agents/security.js";
import { AgentConfig } from "./types/agentConfig.js";

await setupLogger();

const logger = getLogger(["main"]);

async function main() {
    const args = process.argv.slice(2);
    const agentArg = args.find((arg) => arg.startsWith("--agent="))?.split("=")[1];
    const targetArg = args.find((arg) => arg.startsWith("--target="))?.split("=")[1];
    const inputArg = args.find((arg) => arg.startsWith("--input="))?.split("=")[1];

    if (!agentArg || !targetArg) {
        logger.error("Both --agent and --target arguments are required.");
        process.exit(1);
    }

    const agentMap: Record<string, AgentConfig> = {
        security: SecurityAgent,
        // audit: AuditAgent, --- FUTURE ---
    };

    const selectedConfig = agentMap[agentArg.toLowerCase()];

    if (!selectedConfig) {
        logger.error(chalk.red.bold(`❌ Unknown agent type: ${agentArg}`));
        process.exit(1);
    }

    const absoluteTargetPath = path.resolve(process.cwd(), targetArg);

    const finalUserPrompt = inputArg || selectedConfig.defaultUserPrompt;

    console.log(chalk.bold.blue(`\n🤖 Launching ${selectedConfig.name}...`));
    console.log(chalk.gray(`📂 Target: ${absoluteTargetPath}`));
    console.log(chalk.cyan(`📝 Task: ${finalUserPrompt}\n`));

    try {
        const result = await startOrchestrator(selectedConfig, absoluteTargetPath, finalUserPrompt);

        if (result.success) {
            console.log(chalk.green.bold("\n✨ WORKFLOW COMPLETE ✨"));
            console.log(chalk.white(result.report));

            // FUTURE: Add Git PR logic here!
            // if (result.hasChanges) await createMergeRequest(result);
            process.exit(0);
        } else {
            console.log(chalk.red.bold("\n❌ WORKFLOW FAILED"));
            console.log(chalk.red(result.report));
        }
    } catch (err: any) {
        console.error(chalk.red(`\n💥 Fatal Error: ${err.message}`));
        process.exit(1);
    }
}

main();