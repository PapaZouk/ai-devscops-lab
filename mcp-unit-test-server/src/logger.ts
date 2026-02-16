import { configure, getConsoleSink, getLogger } from "@logtape/logtape";

export async function setupLogging(
  level: "debug" | "info" | "warning" | "error" | "fatal" = "info"
): Promise<void> {
  await configure({
    sinks: {
      // getConsoleSink() targets stderr by default — STDIO-safe; never corrupts protocol
      stderr: getConsoleSink(),
    },
    loggers: [
      {
        category: ["unit-test-server"],
        lowestLevel: level,
        sinks: ["stderr"],
      },
    ],
  });
}

// Typed child loggers per module
export const rootLogger = getLogger(["unit-test-server"]);
export const toolLogger = getLogger(["unit-test-server", "tools"]);
export const analysisLogger = getLogger(["unit-test-server", "analysis"]);
