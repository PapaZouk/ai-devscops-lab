import { getLogger } from "@logtape/logtape";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";

const logger = getLogger("getSkillsPath");

export const getSkillsPath = async (): Promise<string> => {
    const skillsPath = path.resolve(process.cwd(), "skills");

    logger.info(chalk.blue.bold(`📁 Skills Directory: ${skillsPath}`));

    try {
        const skillFiles = await fs.promises.readdir(skillsPath);
        logger.info(chalk.blue(`🔍 Found ${skillFiles.length} skills:`));
        skillFiles.forEach(file => logger.info(chalk.gray(`- ${file}`)));
    } catch (err) {
        logger.error(
            chalk.red(
                `❌ Failed to read skills directory: ${err instanceof Error ? err.message : String(err)
                }`
            )
        );
    }

    logger.info(chalk.blue(`📁 Skills Library: ${skillsPath}`));
    return skillsPath;
}