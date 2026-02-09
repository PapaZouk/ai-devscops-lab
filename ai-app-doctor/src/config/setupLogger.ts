import { configure, getConsoleSink } from "@logtape/logtape";

/**
 * Setup the logger for the application.
 */
export async function setupLogger() {
    await configure({
        sinks: { console: getConsoleSink() },
        loggers: [
            { category: "main", lowestLevel: "debug", sinks: ["console"] },
            { category: "orchestrator", lowestLevel: "debug", sinks: ["console"] },
        ]
    });
}