/**
 * MCP Unit Test Writing Server
 *
 * An MCP server that assists AI agents in writing proper Jest unit tests
 * for Node.js / TypeScript projects.
 *
 * Tools:
 *   analyze_file            — Parse exports, signatures, and mock hints from a source file
 *   scan_project            — Understand Jest config, tsconfig, and untested files
 *   generate_test_scaffold  — Produce a complete Jest test file scaffold
 *   read_file               — Read any file for inspection
 *   write_test_file         — Save a generated test file to disk
 *   check_coverage_gaps     — Diff source vs existing tests to find missing coverage
 *   suggest_mock_strategy   — Return ready-to-use mock snippets for detected dependencies
 *   get_jest_config_template — Generate a tailored jest.config.ts
 *   install_test_dependencies — Install only approved test dependencies
 *
 * Resources:
 *   testing-patterns://jest-best-practices
 *   testing-patterns://mocking-guide
 *   testing-patterns://typescript-testing
 *
 * Prompts:
 *   generate-tests-for-file
 *   review-existing-tests
 *   add-edge-case-tests
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupLogging, rootLogger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";

async function main(): Promise<void> {
  let logLevel = (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error" | "warning";
  await setupLogging(logLevel as "debug" | "info" | "warning" | "error" | "fatal");

  rootLogger.info("MCP Unit Test Server starting", {
    version: "1.0.0",
    logLevel,
    nodeVersion: process.version,
  });

  // ─── Validate PROJECT_ROOT ─────────────────────────────────────────────────
  // All tools resolve file paths relative to this variable.
  // We log a clear warning if it is missing but keep the server running so
  // the agent receives the error message from get_project_root() rather than
  // experiencing a silent process crash.
  const projectRoot = process.env.PROJECT_ROOT;
  if (!projectRoot) {
    rootLogger.error(
      "PROJECT_ROOT is not set — all path-dependent tools will return errors. " +
      'Add "PROJECT_ROOT": "/absolute/path/to/your/project" to the MCP server env config.'
    );
  } else {
    rootLogger.info("Project root: {root}", { root: projectRoot });
  }

  // ─── Create MCP server ─────────────────────────────────────────────────────
  const server = new McpServer({
    name: "unit-test-server",
    version: "1.0.0",
  });

  // ─── Register primitives ───────────────────────────────────────────────────
  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  rootLogger.info("MCP primitives registered", {
    tools: 13,  // 0:get_project_root 1:analyze_file 2:scan_project 3:list_untested_files
    // 4:generate_test_scaffold 5:read_file 6:write_test_file 7:check_coverage_gaps
    // 8:suggest_mock_strategy 9:get_jest_config_template
    // 10:validate_test_setup 11:run_tests 12:install_test_dependencies
    resources: 3,
    prompts: 3,
  });

  // ─── Connect transport ─────────────────────────────────────────────────────
  // STDIO transport: safe for Claude Desktop, Cursor, and custom agents.
  // NEVER write to stdout in this process — it corrupts the JSON-RPC stream.
  const transport = new StdioServerTransport();

  process.on("SIGINT", () => {
    rootLogger.info("Received SIGINT, shutting down gracefully");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    rootLogger.info("Received SIGTERM, shutting down gracefully");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    rootLogger.error("Uncaught exception: {error}", { error: err.message });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    rootLogger.error("Unhandled rejection: {reason}", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  await server.connect(transport);
  rootLogger.info("MCP Unit Test Server connected and ready");
}

main().catch((err: unknown) => {
  // Using stderr directly here because LogTape may not be initialized yet
  process.stderr.write(
    `Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
