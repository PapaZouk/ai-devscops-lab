import { configure, getConsoleSink } from "@logtape/logtape";

export async function setupLogger() {
    await configure({
        sinks: { console: getConsoleSink() },
        loggers: [
            { category: "mcp-security-server", lowestLevel: "debug", sinks: ["console"] },
            { category: "orchestrator", lowestLevel: "debug", sinks: ["console"] },
            { category: "main", lowestLevel: "debug", sinks: ["console"] },
            { category: "gitManagement", lowestLevel: "debug", sinks: ["console"] },
            { category: "security", lowestLevel: "debug", sinks: ["console"] },
            { category: "run_command", lowestLevel: "debug", sinks: ["console"] },
            { category: "secureWrite", lowestLevel: "debug", sinks: ["console"] },
            { category: "listFiles", lowestLevel: "debug", sinks: ["console"] },
            { category: "readFile", lowestLevel: "debug", sinks: ["console"] },
            { category: "gitDiff", lowestLevel: "debug", sinks: ["console"] },
        ]
    });
}