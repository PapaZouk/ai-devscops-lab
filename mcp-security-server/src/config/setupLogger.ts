import { configure, getConsoleSink } from "@logtape/logtape";

export async function setupLogger() {
    await configure({
        sinks: { console: getConsoleSink() },
        loggers: [
            { category: "agent", lowestLevel: "debug", sinks: ["console"] },
        ]
    });
}