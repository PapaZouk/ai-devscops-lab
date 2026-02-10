import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import db from "../utils/db.js";
import chalk from "chalk";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("manageMemory");

/**
 * Handles storing and retrieving agent observations to provide "memory"
 * across multiple turns, especially useful for tracking discovered file paths.
 */
export async function handleMemory(
    args: { action: "store" | "recall"; key?: string; value?: string }
) {
    const { action, key, value } = args;
    logger.debug(`manageMemory called with action: ${action}, key: ${key}, value: ${value}`);

    try {
        if (action === "store") {
            if (!key || !value) {
                throw new McpError(ErrorCode.InvalidParams, "❌ Key and Value are required for storing memory.");
            }

            logger.info(chalk.magenta.bold(`🧠 Storing memory: [${key}]`));

            const stmt = db.prepare(`
                INSERT INTO agent_memory (key, value) 
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, timestamp=CURRENT_TIMESTAMP
            `);

            stmt.run(key, value);

            return {
                content: [{
                    type: "text" as const,
                    text: `✅ Memory stored: ${key}`
                }],
                isError: false
            };
        }

        // action === "recall"
        logger.info(chalk.magenta(`📖 Recalling all memories...`));

        const rows = db.prepare("SELECT key, value, timestamp FROM agent_memory ORDER BY timestamp ASC").all();

        return {
            content: [{
                type: "text" as const,
                text: rows.length > 0
                    ? JSON.stringify(rows, null, 2)
                    : "No memories stored yet."
            }],
            isError: false
        };

    } catch (error: any) {
        logger.error(chalk.red.bold(`Error in memoryHandler: ${error.message}`));
        throw new McpError(ErrorCode.InternalError, `Memory operation failed: ${error.message}`);
    }
}