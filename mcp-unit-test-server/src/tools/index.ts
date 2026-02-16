import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolLogger } from "../logger.js";
import { analyzeSourceFile } from "../utils/sourceAnalyzer.js";
import { generateTestScaffold, deriveTestFilePath } from "../utils/testGenerator.js";
import { scanProjectStructure } from "../utils/projectScanner.js";
import { parseJsonOrJsonc } from "../utils/jsonParsing.js";

// ─── PROJECT_ROOT resolution ───────────────────────────────────────────────────
//
// All path resolution flows through these two helpers.
//
// Priority for any path argument:
//   1. Explicit absolute path passed by the caller  → used as-is
//   2. Explicit relative path                       → resolved against PROJECT_ROOT
//   3. No path given                               → PROJECT_ROOT itself
//
// This lets the agent pass bare relative paths like "src/services/user.ts"
// without ever needing to know the absolute location of the project on disk.

/**
 * Return the PROJECT_ROOT environment variable.
 * Throws a descriptive error when it is not set so the agent gets clear feedback.
 */
function getProjectRoot(): string {
  const root = process.env.PROJECT_ROOT;
  if (!root) {
    throw new Error(
      "PROJECT_ROOT environment variable is not set. " +
      "Add it to the MCP server config, e.g.:\n" +
      '  "env": { "PROJECT_ROOT": "/absolute/path/to/your/project" }'
    );
  }
  return root;
}

/**
 * Resolve a user-supplied path against PROJECT_ROOT.
 * Passing null / undefined / "" returns the project root itself.
 */
function resolveProjectPath(userPath?: string | null): string {
  const root = getProjectRoot();
  if (!userPath) return path.resolve(root);
  if (path.isAbsolute(userPath)) return path.resolve(userPath);
  return path.resolve(root, userPath);
}

const ALLOWED_TEST_PACKAGES = [
  "jest",
  "@types/jest",
  "ts-jest",
  "supertest",
  "@types/supertest",
] as const;
type AllowedTestPackage = (typeof ALLOWED_TEST_PACKAGES)[number];

function inferTestConvention(
  sourcePath: string,
  structure: Awaited<ReturnType<typeof scanProjectStructure>>
): "adjacent" | "__tests__" | "src/__tests__" | "tests" {
  const normalizedSource = sourcePath.replace(/\\/g, "/");
  const normalizedTests = structure.testFiles.map((f) => f.replace(/\\/g, "/"));

  const hasTestsFolder = normalizedTests.some((f) => f.includes("/tests/"));
  const hasSrcUnderscoreTests = normalizedTests.some((f) => f.includes("/src/") && f.includes("/__tests__/"));
  const hasUnderscoreTests = normalizedTests.some((f) => f.includes("/__tests__/"));

  if (hasTestsFolder) return "tests";
  if (hasSrcUnderscoreTests) return "src/__tests__";
  if (hasUnderscoreTests) return "__tests__";
  if (normalizedSource.includes("/src/")) return "src/__tests__";
  return "__tests__";
}

/** Register all tools on the MCP server */
export function registerTools(server: McpServer): void {

  // ───────────────────────────────────────────────────────────────────────────
  // 0. get_project_root  ← always the first call in any workflow
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "get_project_root",
    `Returns the project root directory configured via the PROJECT_ROOT environment variable.
This is the base path every other tool uses when resolving relative file paths.
Always call this first to confirm the server is pointed at the right project before
running any analysis or generating any tests.`,
    {},
    async () => {
      toolLogger.info("get_project_root called");
      try {
        const root = getProjectRoot();
        const resolved = path.resolve(root);

        try {
          await fs.access(resolved);
        } catch {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                projectRoot: resolved,
                warning: `Directory does not exist or is not accessible: ${resolved}`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const stat = await fs.stat(resolved);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              projectRoot: resolved,
              isDirectory: stat.isDirectory(),
              hint: "Pass file paths relative to this root in other tool calls — e.g. \"src/services/user.ts\"",
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 1. analyze_file
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "analyze_file",
    `Deeply analyze a TypeScript or JavaScript source file.
Returns: all exported functions (name, async, params, return type, JSDoc), exported classes
(methods + properties), interfaces, type aliases, constants, import dependencies, and
smart suggestions for mocking strategies.

Path resolution: relative paths are resolved against PROJECT_ROOT.
Example: "src/services/userService.ts" → <PROJECT_ROOT>/src/services/userService.ts

Call this before generating any tests.`,
    {
      file_path: z
        .string()
        .describe(
          "Path to the source file. Relative paths are resolved from PROJECT_ROOT. " +
          "Example: \"src/services/userService.ts\""
        ),
    },
    async ({ file_path }) => {
      toolLogger.info("analyze_file called", { file_path });
      try {
        const resolved = resolveProjectPath(file_path);
        toolLogger.debug("analyze_file resolved: {resolved}", { resolved });
        const analysis = await analyzeSourceFile(resolved);
        return {
          content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
        };
      } catch (err) {
        toolLogger.error("analyze_file failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 2. scan_project
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "scan_project",
    `Scan the project and return:
- package.json metadata (jest / vitest / typescript detected, test scripts)
- Jest configuration (testMatch patterns, transform, testEnvironment, coverage thresholds)
- tsconfig.json settings (strict mode, path aliases, baseUrl)
- All source files and existing test files
- Which source files have NO corresponding test file yet
- Actionable setup recommendations

Defaults to scanning the full PROJECT_ROOT. Pass subdirectory to narrow the scan.`,
    {
      subdirectory: z
        .string()
        .optional()
        .describe(
          "Optional path within PROJECT_ROOT to scan. Omit to scan the whole project. " +
          "Example: \"packages/api\""
        ),
    },
    async ({ subdirectory }) => {
      toolLogger.info("scan_project called", { subdirectory });
      try {
        const scanPath = resolveProjectPath(subdirectory ?? null);
        toolLogger.debug("scan_project resolved: {path}", { path: scanPath });
        const structure = await scanProjectStructure(scanPath);
        return {
          content: [{ type: "text", text: JSON.stringify(structure, null, 2) }],
        };
      } catch (err) {
        toolLogger.error("scan_project failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3. list_untested_files  ← dedicated focused tool for the "find gaps" workflow
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "list_untested_files",
    `Return every source file in the project that has no corresponding test file.

Automatically excludes files that should not have unit tests:
  - Barrel / re-export files (index.ts)
  - Config files (jest.config.ts, webpack.config.ts, tsconfig.ts, …)
  - Type declaration files (*.d.ts)
  - Files prefixed with underscore (_helpers.ts, etc.)

Returns paths relative to PROJECT_ROOT so they can be passed directly to
analyze_file, generate_test_scaffold, and other tools without modification.

Use this as the starting point of any "write missing tests" workflow.`,
    {
      subdirectory: z
        .string()
        .optional()
        .describe("Optional subdirectory within PROJECT_ROOT to limit the search (e.g. \"src/services\")"),
      show_existing_tests: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, also include a list of files that DO have tests (for full picture)"),
    },
    async ({ subdirectory, show_existing_tests }) => {
      toolLogger.info("list_untested_files called", { subdirectory });
      try {
        const scanPath   = resolveProjectPath(subdirectory ?? null);
        const projectRoot = getProjectRoot();
        const structure  = await scanProjectStructure(scanPath);

        // Convert absolute paths to project-relative paths for easy reuse
        const toRelative = (abs: string) => path.relative(projectRoot, abs);

        const untestedRelative = structure.untestedSourceFiles.map(toRelative);

        const response: Record<string, unknown> = {
          projectRoot,
          scannedDirectory: scanPath,
          summary: {
            totalSourceFiles: structure.sourceFiles.length,
            totalTestFiles: structure.testFiles.length,
            untestedCount: untestedRelative.length,
            coverageRatio:
              structure.sourceFiles.length > 0
                ? `${Math.round(
                    ((structure.sourceFiles.length - untestedRelative.length) /
                      structure.sourceFiles.length) *
                      100
                  )}% of source files have tests`
                : "no source files found",
          },
          untestedFiles: untestedRelative,
          hint: untestedRelative.length > 0
            ? `Pass any path from untestedFiles directly to analyze_file or generate_test_scaffold — they are already relative to PROJECT_ROOT.`
            : "All source files have corresponding test files.",
        };

        if (show_existing_tests) {
          response.testedFiles = structure.sourceFiles
            .filter((f) => !structure.untestedSourceFiles.includes(f))
            .map(toRelative);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        toolLogger.error("list_untested_files failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. generate_test_scaffold
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "generate_test_scaffold",
    `Generate a complete Jest test file scaffold for a source file.
Produces:
- Correct import statement pointing to the source file
- Auto-detected jest.mock() calls for fs, axios, DB clients, etc.
- One describe() block per exported function/class
- AAA-structured it() cases with Arrange/Act/Assert comments
- Edge-case stubs for string, number, array parameters
- beforeEach / afterEach for fresh instances and mock resets

All paths resolved relative to PROJECT_ROOT.
Returns the generated test content — use write_test_file to save it.`,
    {
      file_path: z
        .string()
        .describe("Source file path, relative to PROJECT_ROOT. Example: \"src/utils/dateUtils.ts\""),
      test_file_path: z
        .string()
        .optional()
        .describe("Override the output test file path (relative to PROJECT_ROOT). Auto-derived if omitted."),
      convention: z
        .enum(["adjacent", "__tests__", "src/__tests__", "tests"])
        .optional()
        .describe("Placement: adjacent to source, __tests__ subfolder, src/__tests__, or tests folder"),
      framework: z
        .enum(["jest", "vitest"])
        .optional()
        .default("jest"),
      include_edge_cases: z
        .boolean()
        .optional()
        .default(true),
    },
    async ({ file_path, test_file_path, convention, framework, include_edge_cases }) => {
      toolLogger.info("generate_test_scaffold called", { file_path });
      try {
        const scanPath = resolveProjectPath(null);
        const structure = await scanProjectStructure(scanPath);
        const resolvedSource  = resolveProjectPath(file_path);
        const selectedConvention = convention ?? inferTestConvention(resolvedSource, structure);
        const resolvedTestPath = test_file_path
          ? resolveProjectPath(test_file_path)
          : deriveTestFilePath(resolvedSource, selectedConvention);

        toolLogger.debug("scaffold paths", { source: resolvedSource, test: resolvedTestPath });

        const analysis = await analyzeSourceFile(resolvedSource);
        const scaffold  = generateTestScaffold(analysis, resolvedTestPath, {
          testFramework: framework ?? "jest",
          includeEdgeCases: include_edge_cases ?? true,
          moduleStyle: "esm",
          mockStrategy: "auto",
          includeTypeChecks: true,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              testFilePath: resolvedTestPath,
              sourceFilePath: analysis.filePath,
              projectRoot: getProjectRoot(),
              language: analysis.language,
              exportCount: analysis.exports.functions.length + analysis.exports.classes.length,
              suggestions: analysis.suggestions,
              scaffold,
            }, null, 2),
          }],
        };
      } catch (err) {
        toolLogger.error("generate_test_scaffold failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 5. read_file
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "read_file",
    `Read the contents of any file in the project.
Relative paths are resolved against PROJECT_ROOT.
Example: "src/controllers/auth.ts" or "jest.config.ts"`,
    {
      file_path: z
        .string()
        .describe("File path, relative to PROJECT_ROOT or absolute."),
      max_lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate to this many lines (default: all)"),
    },
    async ({ file_path, max_lines }) => {
      toolLogger.info("read_file called", { file_path });
      try {
        const resolved = resolveProjectPath(file_path);
        const content  = await fs.readFile(resolved, "utf-8");
        const lines    = content.split("\n");
        const slice    = max_lines ? lines.slice(0, max_lines) : lines;
        const result   = max_lines && lines.length > max_lines
          ? slice.join("\n") + `\n\n... (showing ${max_lines} of ${lines.length} lines)`
          : slice.join("\n");

        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 6. write_test_file
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "write_test_file",
    `Write a test file to disk inside the project.
Relative paths are resolved against PROJECT_ROOT.
Creates intermediate directories automatically.
Requires overwrite: true if the file already exists.`,
    {
      file_path: z
        .string()
        .describe("Destination path, relative to PROJECT_ROOT. Example: \"src/__tests__/user.test.ts\""),
      content:   z.string().describe("Full test file content"),
      overwrite: z.boolean().optional().default(false),
    },
    async ({ file_path, content, overwrite }) => {
      toolLogger.info("write_test_file called", { file_path, overwrite });
      try {
        const resolved = resolveProjectPath(file_path);
        const relPath = path.relative(getProjectRoot(), resolved).replace(/\\/g, "/");
        const testFilePattern = /(?:^|\/)(?:tests\/.*|__tests__\/.*|.*\.(test|spec)\.(ts|tsx|js|jsx)$)/;
        if (!testFilePattern.test(relPath)) {
          return {
            content: [{
              type: "text",
              text: `Refusing to write non-test file: "${relPath}". Use a test path under tests/, __tests__/, or a *.test|*.spec file.`,
            }],
            isError: true,
          };
        }

        try {
          await fs.access(resolved);
          if (!overwrite) {
            return {
              content: [{
                type: "text",
                text: `File already exists at "${resolved}". Pass overwrite: true to replace it.`,
              }],
              isError: true,
            };
          }
        } catch { /* doesn't exist — safe to create */ }

        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf-8");

        toolLogger.info("Test file written: {path}", { path: resolved });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              absolutePath: resolved,
              projectRelativePath: path.relative(getProjectRoot(), resolved),
              lines: content.split("\n").length,
              bytes: Buffer.byteLength(content, "utf-8"),
            }, null, 2),
          }],
        };
      } catch (err) {
        toolLogger.error("write_test_file failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 7. check_coverage_gaps
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "check_coverage_gaps",
    `Compare a source file against its existing test file and report what is missing:
- Exported functions / class methods with no test block
- Async functions missing a rejection test
- Boundary/edge-case gaps

Both paths resolved relative to PROJECT_ROOT.`,
    {
      source_file_path: z
        .string()
        .describe("Source file path, relative to PROJECT_ROOT."),
      test_file_path: z
        .string()
        .describe("Existing test file path, relative to PROJECT_ROOT."),
    },
    async ({ source_file_path, test_file_path }) => {
      toolLogger.info("check_coverage_gaps called", { source_file_path, test_file_path });
      try {
        const resolvedSource = resolveProjectPath(source_file_path);
        const resolvedTest   = resolveProjectPath(test_file_path);
        const analysis       = await analyzeSourceFile(resolvedSource);

        let testContent = "";
        try {
          testContent = await fs.readFile(resolvedTest, "utf-8");
        } catch {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Test file not found: ${resolvedTest}`,
                suggestion: "Use generate_test_scaffold to create an initial test file.",
              }, null, 2),
            }],
          };
        }

        const gaps = {
          untestedFunctions: [] as string[],
          untestedClassMethods: {} as Record<string, string[]>,
          missingRejectionTests: [] as string[],
          missingEdgeCases: [] as string[],
          recommendations: [] as string[],
        };

        for (const fn of analysis.exports.functions) {
          if (
            !testContent.includes(`"${fn.name}`) &&
            !testContent.includes(`'${fn.name}`) &&
            !testContent.includes(fn.name + "(")
          ) {
            gaps.untestedFunctions.push(fn.name);
          }
          if (fn.isAsync && !testContent.includes("rejects") && !testContent.includes("toThrow")) {
            gaps.missingRejectionTests.push(fn.name);
          }
        }

        for (const cls of analysis.exports.classes) {
          const untested: string[] = [];
          for (const method of cls.methods) {
            if (!testContent.includes(method.name + "(") && !testContent.includes(`"${method.name}"`)) {
              untested.push(method.name);
            }
            if (method.isAsync && !testContent.includes("rejects") && !testContent.includes("toThrow")) {
              gaps.missingRejectionTests.push(`${cls.name}.${method.name}`);
            }
          }
          if (untested.length > 0) gaps.untestedClassMethods[cls.name] = untested;
        }

        for (const fn of analysis.exports.functions) {
          if (fn.params.some((p) => p.includes("string")) && !testContent.includes(`""`)) {
            gaps.missingEdgeCases.push(`${fn.name}: empty string input`);
          }
          if (fn.params.some((p) => p.includes("number")) && !testContent.includes("NaN")) {
            gaps.missingEdgeCases.push(`${fn.name}: 0 / negative / NaN inputs`);
          }
        }

        if (gaps.untestedFunctions.length > 0) {
          gaps.recommendations.push(`Add tests for: ${gaps.untestedFunctions.join(", ")}`);
        }
        if (gaps.missingRejectionTests.length > 0) {
          gaps.recommendations.push(`Add rejects.toThrow() for: ${gaps.missingRejectionTests.join(", ")}`);
        }
        if (gaps.missingEdgeCases.length > 0) {
          gaps.recommendations.push("Add boundary tests (empty string, 0, NaN, null).");
        }

        return {
          content: [{ type: "text", text: JSON.stringify(gaps, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 8. suggest_mock_strategy
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "suggest_mock_strategy",
    `Analyze a source file's imports and return ready-to-use Jest mock snippets for
every detected dependency (node:fs, axios, Prisma, Mongoose, AWS SDK, nodemailer…).
Path resolved relative to PROJECT_ROOT.`,
    {
      file_path: z
        .string()
        .describe("Source file path, relative to PROJECT_ROOT."),
    },
    async ({ file_path }) => {
      toolLogger.info("suggest_mock_strategy called", { file_path });
      try {
        const resolved = resolveProjectPath(file_path);
        const analysis = await analyzeSourceFile(resolved);
        const strategies: Array<{ dependency: string; approach: string; codeSnippet: string }> = [];

        for (const imp of analysis.imports) {
          if (imp.includes("node:fs") || imp.match(/from ['"]fs['"]/)) {
            strategies.push({
              dependency: "node:fs/promises",
              approach: "jest.mock() module replacement",
              codeSnippet: `jest.mock("node:fs/promises");
import { readFile, writeFile } from "node:fs/promises";
const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;
beforeEach(() => {
  mockedReadFile.mockResolvedValue(Buffer.from("mock content"));
});`,
            });
          }
          if (imp.includes("axios")) {
            strategies.push({
              dependency: "axios",
              approach: "jest.mock() + typed mock",
              codeSnippet: `jest.mock("axios");
import axios from "axios";
const mockedAxios = axios as jest.Mocked<typeof axios>;
beforeEach(() => {
  mockedAxios.get.mockResolvedValue({ data: {}, status: 200 });
});`,
            });
          }
          if (imp.includes("prisma") || imp.includes("@prisma")) {
            strategies.push({
              dependency: "@prisma/client",
              approach: "jest-mock-extended",
              codeSnippet: `// npm install --save-dev jest-mock-extended
import { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset } from "jest-mock-extended";
export const prismaMock = mockDeep<PrismaClient>();
jest.mock("../lib/prisma", () => ({ prisma: prismaMock }));
beforeEach(() => { mockReset(prismaMock); });`,
            });
          }
          if (imp.includes("mongoose")) {
            strategies.push({
              dependency: "mongoose",
              approach: "jest.spyOn on model methods",
              codeSnippet: `import { UserModel } from "../models/User";
const spy = jest.spyOn(UserModel, "findOne").mockResolvedValue({ _id: "abc" } as any);
afterEach(() => spy.mockRestore());`,
            });
          }
          if (imp.includes("nodemailer")) {
            strategies.push({
              dependency: "nodemailer",
              approach: "jest.mock() with sendMail spy",
              codeSnippet: `jest.mock("nodemailer");
import nodemailer from "nodemailer";
const sendMailMock = jest.fn().mockResolvedValue({ messageId: "id" });
(nodemailer as jest.Mocked<typeof nodemailer>)
  .createTransport.mockReturnValue({ sendMail: sendMailMock } as any);`,
            });
          }
          if (imp.includes("@aws-sdk")) {
            strategies.push({
              dependency: "@aws-sdk/*",
              approach: "jest.mock() + prototype.send",
              codeSnippet: `import { S3Client } from "@aws-sdk/client-s3";
jest.mock("@aws-sdk/client-s3");
const mockSend = jest.fn().mockResolvedValue({});
(S3Client as jest.MockedClass<typeof S3Client>).prototype.send = mockSend;`,
            });
          }
        }

        strategies.push({
          dependency: "process.env",
          approach: "Save/restore pattern",
          codeSnippet: `const orig = process.env;
beforeEach(() => { process.env = { ...orig, NODE_ENV: "test" }; });
afterEach(() => { process.env = orig; });`,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sourceFile: resolved,
              projectRoot: getProjectRoot(),
              mockStrategies: strategies,
              generalTips: [
                "jest.clearAllMocks() in afterEach resets call counts and return values.",
                "jest.mock() is hoisted — prefer it over manual property replacement.",
                "jest.spyOn() when you need to mock one method and keep the rest real.",
              ],
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 9. get_jest_config_template
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "get_jest_config_template",
    `Generate a tailored jest.config.ts for the project.
Reads tsconfig.json path aliases and builds the correct moduleNameMapper automatically.
Defaults to PROJECT_ROOT; pass subdirectory for monorepo packages.`,
    {
      subdirectory: z
        .string()
        .optional()
        .describe("Optional subdirectory within PROJECT_ROOT (e.g. \"packages/api\"). Omit for project root."),
      use_swc: z
        .boolean()
        .optional()
        .default(false)
        .describe("Use @swc/jest (faster) instead of ts-jest"),
      test_environment: z
        .enum(["node", "jsdom"])
        .optional()
        .default("node"),
      coverage_threshold: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .default(80),
    },
    async ({ subdirectory, use_swc, test_environment, coverage_threshold }) => {
      toolLogger.info("get_jest_config_template called");
      try {
        const scanPath   = resolveProjectPath(subdirectory ?? null);
        const structure  = await scanProjectStructure(scanPath);
        const threshold  = coverage_threshold ?? 80;

        const nameMapper: Record<string, string> = {
          "^(\\.{1,2}/.*)\\.js$": "$1",
        };
        for (const [alias, targets] of Object.entries(structure.tsConfig.paths)) {
          const key    = alias.replace("/*", "/(.*)");
          const target = targets[0]?.replace("/*", "/$1") ?? "";
          nameMapper[`^${key}$`] = `<rootDir>/${target}`;
        }

        const configTemplate = `import type { Config } from "jest";

const config: Config = {
  preset: ${use_swc ? '"@swc/jest"' : '"ts-jest"'},
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "${test_environment ?? "node"}",
  transform: {
    "^.+\\.tsx?$": [${use_swc ? '"@swc/jest"' : '"ts-jest"'}, { useESM: true${use_swc ? "" : ", tsconfig: { strict: true }"} }],
  },
  moduleNameMapper: ${JSON.stringify(nameMapper, null, 4)},
  testMatch: ["**/__tests__/**/*.test.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/", "/build/", "/dist/"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  coverageProvider: "v8",
  coverageThreshold: {
    global: {
      lines: ${threshold},
      branches: ${Math.max(threshold - 5, 0)},
      functions: ${threshold},
      statements: ${threshold},
    },
  },
  verbose: process.env.CI === "true",
};

export default config;
`;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              configTemplate,
              saveAs: path.join(scanPath, "jest.config.ts"),
              projectRoot: getProjectRoot(),
              installCommand: use_swc
                ? "npm install --save-dev jest @types/jest @swc/jest @swc/core"
                : "npm install --save-dev jest @types/jest ts-jest",
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 10. validate_test_setup
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "validate_test_setup",
    `Deeply audit the project's test infrastructure and report every problem that would
prevent tests from running. Checks:

DEPENDENCIES
  - jest / vitest installed
  - ts-jest or @swc/jest present when TypeScript is detected
  - @types/jest installed for TypeScript projects
  - All packages declared in jest transform/preset actually exist in node_modules
  - node_modules directory exists at all (i.e. npm install has been run)

JEST CONFIGURATION
  - jest.config.* file exists (or jest key in package.json)
  - preset value matches an installed package
  - transform keys compile to a runnable loader
  - testEnvironment value is valid
  - moduleNameMapper ESM fix present when "type":"module" in package.json
  - testMatch / testPathIgnorePatterns are sensible

TYPESCRIPT
  - tsconfig.json present
  - compilerOptions.strict enabled (warning if not)
  - module / moduleResolution compatible with jest transform
  - paths aliases have a corresponding moduleNameMapper entry in jest config

ENVIRONMENT
  - node_modules/.bin/jest (or vitest) executable exists
  - No conflicting jest versions in nested node_modules

Returns a structured report: errors (block test execution), warnings (degrade quality),
and a recommended fix for each issue.`,
    {
      subdirectory: z
        .string()
        .optional()
        .describe("Subdirectory within PROJECT_ROOT to audit. Omit to audit the full project."),
    },
    async ({ subdirectory }) => {
      toolLogger.info("validate_test_setup called");
      try {
        const scanPath    = resolveProjectPath(subdirectory ?? null);
        const projectRoot = getProjectRoot();

        const errors:   Array<{ code: string; message: string; fix: string }> = [];
        const warnings: Array<{ code: string; message: string; fix: string }> = [];
        const passed:   string[] = [];

        // ── Helper: check if a package exists in node_modules ────────────────
        const inNodeModules = async (pkg: string): Promise<boolean> => {
          // Handle scoped packages and sub-paths: just check the package root
          const pkgRoot = pkg.startsWith("@")
            ? pkg.split("/").slice(0, 2).join("/")
            : pkg.split("/")[0];
          try {
            await fs.access(path.join(scanPath, "node_modules", pkgRoot as string));
            return true;
          } catch {
            return false;
          }
        };

        // ── 1. node_modules exists ───────────────────────────────────────────
        const nmExists = await inNodeModules("."); // check node_modules itself
        try {
          await fs.access(path.join(scanPath, "node_modules"));
          passed.push("node_modules directory exists");
        } catch {
          errors.push({
            code: "NO_NODE_MODULES",
            message: "node_modules directory not found — dependencies are not installed.",
            fix: `Run: cd ${scanPath} && npm install`,
          });
        }

        // ── 2. Read package.json ─────────────────────────────────────────────
        let pkg: Record<string, unknown> = {};
        try {
          const raw = await fs.readFile(path.join(scanPath, "package.json"), "utf-8");
          pkg = JSON.parse(raw) as Record<string, unknown>;
          passed.push("package.json found and valid JSON");
        } catch {
          errors.push({
            code: "NO_PACKAGE_JSON",
            message: "package.json not found or invalid JSON.",
            fix: "Ensure you are pointing PROJECT_ROOT at the correct directory.",
          });
        }

        const allDeps: Record<string, string> = {
          ...((pkg.dependencies as Record<string, string>) ?? {}),
          ...((pkg.devDependencies as Record<string, string>) ?? {}),
        };
        const isEsmPackage = (pkg.type as string) === "module";
        const hasTS = "typescript" in allDeps;

        // ── 3. Jest or Vitest declared ───────────────────────────────────────
        const hasJest   = "jest" in allDeps || "@jest/globals" in allDeps;
        const hasVitest = "vitest" in allDeps;

        if (!hasJest && !hasVitest) {
          errors.push({
            code: "NO_TEST_FRAMEWORK",
            message: "Neither jest nor vitest found in dependencies.",
            fix: "npm install --save-dev jest @types/jest ts-jest",
          });
        } else {
          passed.push(`Test framework declared: ${hasVitest ? "vitest" : "jest"}`);

          // Check the binary actually exists
          const binName = hasVitest ? "vitest" : "jest";
          try {
            await fs.access(path.join(scanPath, "node_modules", ".bin", binName));
            passed.push(`${binName} binary found in node_modules/.bin`);
          } catch {
            errors.push({
              code: "MISSING_BIN",
              message: `${binName} declared in package.json but binary missing from node_modules/.bin.`,
              fix: `npm install (node_modules may be stale or incomplete)`,
            });
          }
        }

        // ── 4. TypeScript-specific deps ──────────────────────────────────────
        if (hasTS && hasJest) {
          const hasTsJest = "ts-jest" in allDeps;
          const hasSwcJest = "@swc/jest" in allDeps;

          if (!hasTsJest && !hasSwcJest) {
            errors.push({
              code: "NO_TS_TRANSFORM",
              message: "TypeScript project with Jest but no ts-jest or @swc/jest transform found.",
              fix: "npm install --save-dev ts-jest  OR  npm install --save-dev @swc/jest @swc/core",
            });
          } else {
            passed.push(`TypeScript transform: ${hasTsJest ? "ts-jest" : "@swc/jest"}`);

            // Check the transform package is actually installed
            const transformPkg = hasTsJest ? "ts-jest" : "@swc/jest";
            if (!(await inNodeModules(transformPkg))) {
              errors.push({
                code: "TRANSFORM_NOT_INSTALLED",
                message: `${transformPkg} declared in package.json but not found in node_modules.`,
                fix: "npm install",
              });
            }
          }

          if (!("@types/jest" in allDeps)) {
            warnings.push({
              code: "NO_TYPES_JEST",
              message: "@types/jest not installed — TypeScript will not recognise describe/it/expect.",
              fix: "npm install --save-dev @types/jest",
            });
          } else {
            passed.push("@types/jest installed");
          }
        }

        // ── 5. Jest config file ──────────────────────────────────────────────
        const jestConfigFiles = [
          "jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs",
        ];
        let foundJestConfig: string | null = null;
        for (const f of jestConfigFiles) {
          try {
            await fs.access(path.join(scanPath, f));
            foundJestConfig = f;
            break;
          } catch { /* not found */ }
        }

        const hasInlineJestConfig = typeof pkg.jest === "object" && pkg.jest !== null;

        if (!foundJestConfig && !hasInlineJestConfig) {
          errors.push({
            code: "NO_JEST_CONFIG",
            message: "No jest.config.* file and no jest key in package.json found.",
            fix: "Call get_jest_config_template to generate a jest.config.ts, then write_test_file to save it.",
          });
        } else {
          passed.push(`Jest config found: ${foundJestConfig ?? "package.json#jest"}`);

          // Read & inspect config if it's a JS/JSON variant we can parse
          if (foundJestConfig && (foundJestConfig.endsWith(".js") || foundJestConfig.endsWith(".cjs"))) {
            try {
              const raw = await fs.readFile(path.join(scanPath, foundJestConfig), "utf-8");

              // Check for ESM moduleNameMapper fix
              if (isEsmPackage && !raw.includes("moduleNameMapper")) {
                warnings.push({
                  code: "MISSING_ESM_MAPPER",
                  message: 'package.json has "type":"module" but jest.config has no moduleNameMapper for .js extension rewriting.',
                  fix: 'Add to jest.config: moduleNameMapper: { "^(\\\\.{1,2}/.*)\\\\.js$": "$1" }',
                });
              }

              // Check preset is installed
              const presetMatch = raw.match(/preset\s*:\s*["']([^"']+)["']/);
              if (presetMatch) {
                const preset = presetMatch[1];
                if (preset && !(await inNodeModules(preset))) {
                  errors.push({
                    code: "PRESET_NOT_INSTALLED",
                    message: `Jest preset "${preset}" declared but not found in node_modules.`,
                    fix: `npm install --save-dev ${preset}`,
                  });
                }
              }

              // Check testEnvironment
              const envMatch = raw.match(/testEnvironment\s*:\s*["']([^"']+)["']/);
              if (envMatch) {
                const env = envMatch[1];
                if (env === "jsdom" && !(await inNodeModules("jest-environment-jsdom"))) {
                  errors.push({
                    code: "MISSING_JSDOM",
                    message: 'testEnvironment is "jsdom" but jest-environment-jsdom is not installed.',
                    fix: "npm install --save-dev jest-environment-jsdom",
                  });
                }
              }
            } catch { /* couldn't read config */ }
          }

          // .ts config — we can still do text-based checks
          if (foundJestConfig?.endsWith(".ts")) {
            try {
              const raw = await fs.readFile(path.join(scanPath, foundJestConfig), "utf-8");

              if (isEsmPackage && !raw.includes("moduleNameMapper")) {
                warnings.push({
                  code: "MISSING_ESM_MAPPER",
                  message: 'package.json has "type":"module" but no moduleNameMapper for .js extension rewriting detected.',
                  fix: 'Add: moduleNameMapper: { "^(\\\\.{1,2}/.*)\\\\.js$": "$1" }',
                });
              }

              const presetMatch = raw.match(/preset\s*:\s*["']([^"']+)["']/);
              if (presetMatch) {
                const preset = presetMatch[1];
                if (preset && !(await inNodeModules(preset))) {
                  errors.push({
                    code: "PRESET_NOT_INSTALLED",
                    message: `Jest preset "${preset}" declared but not found in node_modules.`,
                    fix: `npm install --save-dev ${preset}`,
                  });
                } else if (preset) {
                  passed.push(`Jest preset "${preset}" is installed`);
                }
              }

              const envMatch = raw.match(/testEnvironment\s*:\s*["']([^"']+)["']/);
              if (envMatch && envMatch[1] === "jsdom") {
                if (!(await inNodeModules("jest-environment-jsdom"))) {
                  errors.push({
                    code: "MISSING_JSDOM",
                    message: 'testEnvironment is "jsdom" but jest-environment-jsdom is not installed.',
                    fix: "npm install --save-dev jest-environment-jsdom",
                  });
                }
              }
            } catch { /* couldn't read */ }
          }
        }

        // ── 6. tsconfig checks ───────────────────────────────────────────────
        if (hasTS) {
          try {
            const tsraw = await fs.readFile(path.join(scanPath, "tsconfig.json"), "utf-8");
            const tsconfig = parseJsonOrJsonc(tsraw);
            if (!tsconfig) {
              throw new Error("Invalid tsconfig.json format");
            }
            const co = (tsconfig.compilerOptions as Record<string, unknown>) ?? {};

            if (!co.strict) {
              warnings.push({
                code: "TS_STRICT_OFF",
                message: "TypeScript strict mode is disabled — type errors in tests may go undetected.",
                fix: 'Add "strict": true to tsconfig.json compilerOptions.',
              });
            } else {
              passed.push("TypeScript strict mode enabled");
            }

            const mod = (co.module as string ?? "").toLowerCase();
            const modRes = (co.moduleResolution as string ?? "").toLowerCase();

            if (mod.includes("node16") || mod.includes("nodenext")) {
              if (!modRes.includes("node16") && !modRes.includes("nodenext")) {
                warnings.push({
                  code: "MODULERES_MISMATCH",
                  message: `module is "${co.module}" but moduleResolution is "${co.moduleResolution ?? "not set"}". They should match.`,
                  fix: `Set "moduleResolution": "${co.module}" in tsconfig.json`,
                });
              }
            }

            // Check path aliases have matching moduleNameMapper
            const tsPaths = (co.paths as Record<string, unknown>) ?? {};
            const aliasCount = Object.keys(tsPaths).length;
            if (aliasCount > 0 && !foundJestConfig && !hasInlineJestConfig) {
              warnings.push({
                code: "PATHS_NO_MAPPER",
                message: `tsconfig has ${aliasCount} path alias(es) but no jest config found to mirror them as moduleNameMapper.`,
                fix: "Run get_jest_config_template — it auto-generates moduleNameMapper from tsconfig paths.",
              });
            }
          } catch {
            warnings.push({
              code: "NO_TSCONFIG",
              message: "TypeScript detected but tsconfig.json not found at project root.",
              fix: "Create tsconfig.json or verify PROJECT_ROOT points to the right directory.",
            });
          }
        }

        // ── 7. Test files exist ──────────────────────────────────────────────
        const structure = await scanProjectStructure(scanPath);
        if (structure.testFiles.length === 0) {
          warnings.push({
            code: "NO_TEST_FILES",
            message: "No test files found (*.test.ts / *.spec.ts / __tests__/**). Nothing to run yet.",
            fix: "Use list_untested_files then generate_test_scaffold to create your first tests.",
          });
        } else {
          passed.push(`${structure.testFiles.length} test file(s) found`);
        }

        // ── Summary ──────────────────────────────────────────────────────────
        const canRun = errors.length === 0;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              projectRoot,
              auditedDirectory: scanPath,
              canRunTests: canRun,
              summary: canRun
                ? `✅ Setup looks good — ${passed.length} checks passed, ${warnings.length} warning(s).`
                : `❌ ${errors.length} error(s) must be fixed before tests can run.`,
              errors,
              warnings,
              passed,
            }, null, 2),
          }],
        };
      } catch (err) {
        toolLogger.error("validate_test_setup failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 11. run_tests
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "run_tests",
    `Execute Jest (or the project's configured test script) and return structured results.

Supports:
  - Running the full test suite
  - Running a single file or glob pattern
  - Running only tests matching a name pattern (-t flag)
  - Collecting coverage
  - Passing arbitrary extra flags

Returns:
  - Exit code and whether tests passed
  - Full stdout + stderr output
  - Parsed summary: test suites passed/failed, tests passed/failed, duration
  - Per-file results extracted from Jest's output
  - Coverage summary lines (when coverage: true)

Always calls validate_test_setup first and aborts early with a clear message
if the setup has blocking errors, so the agent doesn't waste time running
a broken configuration.`,
    {
      test_path_pattern: z
        .string()
        .optional()
        .describe(
          "File path, directory, or glob to run — relative to PROJECT_ROOT. " +
          "Example: \"src/__tests__/userService.test.ts\" or \"src/__tests__\"  " +
          "Omit to run the full test suite."
        ),
      test_name_pattern: z
        .string()
        .optional()
        .describe("Filter tests by name (passed as Jest -t flag). Example: \"should return 200\""),
      coverage: z
        .boolean()
        .optional()
        .default(false)
        .describe("Collect and report code coverage (adds --coverage flag)"),
      watch: z
        .boolean()
        .optional()
        .default(false)
        .describe("Run in watch mode — only useful for interactive sessions, not agent workflows"),
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .max(300)
        .optional()
        .default(60)
        .describe("Kill the test process after this many seconds (default: 60)"),
      extra_flags: z
        .string()
        .optional()
        .describe("Any additional Jest CLI flags as a single string. Example: \"--verbose --forceExit\""),
    },
    async ({ test_path_pattern, test_name_pattern, coverage, watch, timeout_seconds, extra_flags }) => {
      toolLogger.info("run_tests called", { test_path_pattern, coverage });

      const { spawn } = await import("node:child_process");

      try {
        const scanPath = resolveProjectPath(null);
        const projectRoot = getProjectRoot();
        const structure = await scanProjectStructure(scanPath);

        // ── Runner selection ────────────────────────────────────────────────
        // Prefer project-defined npm test script so repo-specific config
        // (e.g. jest --config ...) is always respected.
        let jestBin = path.join(scanPath, "node_modules", ".bin", "jest");
        let useNpm = false;
        let hasTestScript = false;
        let isEsmPackage = false;

        try {
          const pkgRaw = await fs.readFile(path.join(scanPath, "package.json"), "utf-8");
          const pkg = parseJsonOrJsonc(pkgRaw) as { scripts?: Record<string, string>; type?: string } | null;
          hasTestScript =
            typeof pkg?.scripts?.test === "string" && pkg.scripts.test.trim().length > 0;
          isEsmPackage = pkg?.type === "module";
        } catch {
          hasTestScript = false;
          isEsmPackage = false;
        }

        if (hasTestScript) {
          jestBin = "npm";
          useNpm = true;
        } else {
          try {
            await fs.access(jestBin);
          } catch {
            // Fall back to npm test
            jestBin = "npm";
            useNpm = true;
          }

          // Try vitest if jest not found and no npm test script exists
          if (useNpm) {
            const vitestBin = path.join(scanPath, "node_modules", ".bin", "vitest");
            try {
              await fs.access(vitestBin);
              jestBin = vitestBin;
              useNpm = false;
            } catch { /* not found either */ }
          }
        }

        // ── Build CLI args ──────────────────────────────────────────────────
        let args: string[] = [];

        if (useNpm) {
          args = ["test", "--"];
        }

        let effectiveTestPathPattern = test_path_pattern;
        if (!effectiveTestPathPattern) {
          // Default to explicit test directories first so existing Jest testMatch
          // conventions are respected and we avoid broad "src" patterns.
          const hasUnitDir = structure.testFiles.some((f) =>
            f.includes("/tests/unit/") || f.includes("\\tests\\unit\\")
          );
          const hasTestsDir = structure.testFiles.some((f) =>
            f.includes("/tests/") || f.includes("\\tests\\")
          );
          const hasSrcTests = structure.testFiles.some((f) =>
            (f.includes("/src/") || f.includes("\\src\\")) &&
            (f.includes("/__tests__/") || f.includes("\\__tests__\\"))
          );
          const hasAnyDoubleUnderscoreTests = structure.testFiles.some((f) =>
            f.includes("/__tests__/") || f.includes("\\__tests__\\")
          );

          if (hasUnitDir) {
            effectiveTestPathPattern = "tests/unit";
          } else if (hasTestsDir) {
            effectiveTestPathPattern = "tests";
          } else if (hasSrcTests) {
            effectiveTestPathPattern = "src/__tests__";
          } else if (hasAnyDoubleUnderscoreTests) {
            effectiveTestPathPattern = "__tests__";
          }
        }

        if (effectiveTestPathPattern) {
          // Jest path arguments behave better with concrete file/dir paths than glob-like
          // strings passed after "npm test --". Normalize wildcard patterns to a stable prefix.
          const wildcardIndex = effectiveTestPathPattern.search(/[*?[{]/);
          const patternForRunner = wildcardIndex >= 0
            ? effectiveTestPathPattern.slice(0, wildcardIndex).replace(/[\\/]+$/, "")
            : effectiveTestPathPattern;

          if (patternForRunner) {
            const resolvedPattern = path.isAbsolute(patternForRunner)
              ? patternForRunner
              : path.join(projectRoot, patternForRunner);
            args.push(resolvedPattern);
          }
        }

        if (test_name_pattern) {
          args.push("-t", test_name_pattern);
        }
        if (coverage) {
          args.push("--coverage");
        }
        if (watch) {
          args.push("--watchAll=false"); // safe default: single run even if watch requested
        }
        if (extra_flags) {
          args.push(...extra_flags.split(" ").filter(Boolean));
        }

        // Always add --no-color for clean parsing and --passWithNoTests to avoid
        // failing when a pattern matches no files
        if (!useNpm) {
          args.push("--no-color", "--passWithNoTests");
        }

        toolLogger.debug("Spawning test runner: {bin} {args}", {
          bin: jestBin,
          args: args.join(" "),
        });

        // ── Spawn ───────────────────────────────────────────────────────────
        const timeoutMs = (timeout_seconds ?? 60) * 1000;

        const result = await new Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }>((resolve) => {
          const chunks: Buffer[] = [];
          const errChunks: Buffer[] = [];
          let timedOut = false;

          const child = spawn(jestBin, args, {
            cwd: scanPath,
            env: {
              ...process.env,
              FORCE_COLOR: "0",
              CI: "true",
              // ESM TypeScript projects need this for Jest runtime to execute ESM test modules.
              ...(isEsmPackage
                ? {
                    NODE_OPTIONS: [
                      process.env.NODE_OPTIONS ?? "",
                      "--experimental-vm-modules",
                    ]
                      .join(" ")
                      .trim(),
                  }
                : {}),
            },
            shell: useNpm,
          });

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

          child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
          child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              exitCode: code ?? 1,
              stdout: Buffer.concat(chunks).toString("utf-8"),
              stderr: Buffer.concat(errChunks).toString("utf-8"),
              timedOut,
            });
          });
        });

        // ── Parse Jest output ───────────────────────────────────────────────
        const combinedOutput = result.stdout + "\n" + result.stderr;

        // Test suites line: "Test Suites: 2 failed, 5 passed, 7 total"
        const suitesMatch = combinedOutput.match(
          /Test Suites:\s*((?:\d+ \w+,?\s*)+)/
        );
        // Tests line: "Tests: 1 failed, 12 passed, 13 total"
        const testsMatch = combinedOutput.match(
          /Tests:\s*((?:\d+ \w+,?\s*)+)/
        );
        // Duration: "Time: 3.456 s"
        const timeMatch = combinedOutput.match(/Time:\s*([\d.]+\s*s)/);

        // Per-file: lines like "  ✓ src/__tests__/user.test.ts (234 ms)"
        //           or        "  ✗ FAIL src/__tests__/auth.test.ts"
        const fileResults: Array<{ file: string; status: "pass" | "fail" }> = [];
        for (const line of combinedOutput.split("\n")) {
          const passLine = line.match(/PASS\s+([\w/.\-_]+\.(?:test|spec)\.[jt]sx?)/);
          const failLine = line.match(/FAIL\s+([\w/.\-_]+\.(?:test|spec)\.[jt]sx?)/);
          if (passLine) fileResults.push({ file: passLine[1], status: "pass" });
          if (failLine) fileResults.push({ file: failLine[1], status: "fail" });
        }

        // Coverage summary lines
        const coverageLines = combinedOutput
          .split("\n")
          .filter((l) =>
            l.includes("% Stmts") ||
            l.includes("% Branch") ||
            l.includes("% Funcs") ||
            l.includes("% Lines") ||
            l.includes("All files")
          )
          .slice(0, 20); // cap to avoid huge output

        const passed = result.exitCode === 0 && !result.timedOut;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              passed,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              summary: {
                suites:   suitesMatch?.[1]?.trim() ?? "unknown",
                tests:    testsMatch?.[1]?.trim()  ?? "unknown",
                duration: timeMatch?.[1]?.trim()   ?? "unknown",
              },
              fileResults,
              coverageSummary: coverage ? coverageLines : [],
              // Full output — the agent can read it to diagnose specific failures
              stdout: result.stdout.slice(0, 8000),  // cap at 8 KB
              stderr: result.stderr.slice(0, 4000),
              effectiveTestPathPattern: effectiveTestPathPattern ?? null,
              hint: passed
                ? "All tests passed."
                : result.timedOut
                  ? `Tests timed out after ${timeout_seconds}s. Try a smaller test_path_pattern or increase timeout_seconds.`
                  : "Tests failed. Read stdout/stderr for details, then use check_coverage_gaps or read_file to inspect failing tests.",
            }, null, 2),
          }],
        };
      } catch (err) {
        toolLogger.error("run_tests failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 12. install_test_dependencies
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "install_test_dependencies",
    `Install approved test dependencies in the target project.

Safety guards:
- Only these package names are allowed: jest, @types/jest, ts-jest, supertest, @types/supertest
- Package manager is fixed to npm
- Installs only as devDependencies

Use this when tests fail due to missing Jest tooling.`,
    {
      packages: z
        .array(z.enum(ALLOWED_TEST_PACKAGES))
        .optional()
        .default([...ALLOWED_TEST_PACKAGES])
        .describe("Subset of allowed packages to install. Defaults to all allowed packages."),
    },
    async ({ packages }) => {
      toolLogger.info("install_test_dependencies called", { packages });
      const { spawn } = await import("node:child_process");

      try {
        const projectRoot = resolveProjectPath(null);

        // Extra runtime guard in case tool contracts are bypassed.
        const uniquePackages = [...new Set(packages)] as AllowedTestPackage[];
        const disallowed = uniquePackages.filter(
          (pkg) => !(ALLOWED_TEST_PACKAGES as readonly string[]).includes(pkg)
        );
        if (disallowed.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Refused install. Disallowed package(s): ${disallowed.join(", ")}`,
            }],
            isError: true,
          };
        }

        if (uniquePackages.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No packages requested. Allowed packages: jest, @types/jest, ts-jest, supertest, @types/supertest.",
            }],
            isError: true,
          };
        }

        const packageJsonPath = path.join(projectRoot, "package.json");
        await fs.access(packageJsonPath);

        const pkgRaw = await fs.readFile(packageJsonPath, "utf-8");
        const pkg = parseJsonOrJsonc(pkgRaw) as { devDependencies?: Record<string, string> } | null;
        const existingDevDeps = pkg?.devDependencies ?? {};
        const missingPackages = uniquePackages.filter((name) => !(name in existingDevDeps));

        if (missingPackages.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  projectRoot,
                  installed: [],
                  alreadyPresent: uniquePackages,
                  allowed: ALLOWED_TEST_PACKAGES,
                  skipped: "All requested packages already exist in devDependencies.",
                },
                null,
                2
              ),
            }],
          };
        }

        const args = ["install", "--save-dev", ...missingPackages];
        const result = await new Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const out: Buffer[] = [];
          const err: Buffer[] = [];

          const child = spawn("npm", args, {
            cwd: projectRoot,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
            shell: false,
          });

          child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
          child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
          child.on("close", (code) => {
            resolve({
              exitCode: code ?? 1,
              stdout: Buffer.concat(out).toString("utf-8"),
              stderr: Buffer.concat(err).toString("utf-8"),
            });
          });
        });

        const ok = result.exitCode === 0;
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                success: ok,
                projectRoot,
                installed: missingPackages,
                alreadyPresent: uniquePackages.filter((name) => name in existingDevDeps),
                allowed: ALLOWED_TEST_PACKAGES,
                command: `npm ${args.join(" ")}`,
                exitCode: result.exitCode,
                stdout: result.stdout.slice(0, 8000),
                stderr: result.stderr.slice(0, 4000),
              },
              null,
              2
            ),
          }],
          isError: !ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
