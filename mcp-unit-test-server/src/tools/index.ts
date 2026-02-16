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
const ALLOWED_DELIVERY_COMMANDS = ["git", "gh"] as const;

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

function normalizeWithoutExt(p: string): string {
  return p.replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

async function existsAsModuleCandidate(absPathWithoutGuarantee: string): Promise<boolean> {
  const candidates = [
    absPathWithoutGuarantee,
    `${absPathWithoutGuarantee}.ts`,
    `${absPathWithoutGuarantee}.tsx`,
    `${absPathWithoutGuarantee}.js`,
    `${absPathWithoutGuarantee}.jsx`,
    `${absPathWithoutGuarantee}.mjs`,
    `${absPathWithoutGuarantee}.cjs`,
    path.join(absPathWithoutGuarantee, "index.ts"),
    path.join(absPathWithoutGuarantee, "index.tsx"),
    path.join(absPathWithoutGuarantee, "index.js"),
    path.join(absPathWithoutGuarantee, "index.jsx"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return true;
    } catch { /* try next candidate */ }
  }
  return false;
}

function deriveRunTestsFailureDiagnostics(opts: {
  timedOut: boolean;
  qualityIssues: Array<{ file: string; issues: string[] }>;
  stderr: string;
  combinedOutput: string;
}): Record<string, unknown> | null {
  const { timedOut, qualityIssues, stderr, combinedOutput } = opts;

  if (timedOut) {
    return {
      failureType: "timeout",
      recommendation: "Increase timeout_seconds or narrow test_path_pattern to a smaller scope.",
    };
  }

  if (qualityIssues.length > 0) {
    return {
      failureType: "quality_gate",
      qualityIssues,
      recommendation: "Replace scaffold placeholders and add behavior assertions before rerunning tests.",
    };
  }

  if (!stderr.trim()) return null;

  const failingCase = stderr.match(/●\s+([^\n]+)/)?.[1]?.trim() ?? null;
  const failingLocationMatch = stderr.match(/\(([^()]+):(\d+):(\d+)\)/);
  const failingLocation = failingLocationMatch
    ? {
      file: failingLocationMatch[1],
      line: Number(failingLocationMatch[2]),
      column: Number(failingLocationMatch[3]),
    }
    : null;

  const moduleResolution = stderr.match(/Could not locate module\s+(.+?)\s+mapped as:\s*([^\n]+)/i);
  if (moduleResolution) {
    return {
      failureType: "module_resolution",
      failingCase,
      failingLocation,
      modulePath: moduleResolution[1]?.trim() ?? null,
      mappedAs: moduleResolution[2]?.trim() ?? null,
      recommendation:
        "Fix relative import/mock paths from the test file location. In tests/**, source modules are often under ../../src/**.",
    };
  }

  const namedExport = stderr.match(/does not provide an export named ['"]([^'"]+)['"]/i);
  if (namedExport) {
    return {
      failureType: "esm_named_export",
      failingCase,
      failingLocation,
      missingExport: namedExport[1],
      recommendation:
        "If importing a TypeScript interface/type, use import type and keep runtime imports separate.",
    };
  }

  if (/expect\(received\)\.tohavelength\(expected\)/i.test(stderr)) {
    return {
      failureType: "assertion_length",
      failingCase,
      failingLocation,
      recommendation:
        "Reset shared mutable state in beforeEach and align expected collection sizes with real seeded state.",
    };
  }

  if (/expect\(received\)\.toequal\(expected\)/i.test(stderr)) {
    return {
      failureType: "assertion_equality",
      failingCase,
      failingLocation,
      recommendation:
        "Update expected values to match runtime behavior from source code; avoid hardcoded IDs/counts when state mutates.",
    };
  }

  if (/test suite failed to run/i.test(stderr)) {
    return {
      failureType: "suite_runtime_error",
      failingCase,
      failingLocation,
      recommendation: "Fix import/initialization errors before asserting test behavior.",
    };
  }

  if (/FAIL\s+[\w/.\-_]+\.(?:test|spec)\.[jt]sx?/m.test(combinedOutput)) {
    return {
      failureType: "test_failures",
      failingCase,
      failingLocation,
      recommendation: "Inspect stderr assertions and patch tests incrementally based on the first failing case.",
    };
  }

  return {
    failureType: "unknown",
    failingCase,
    failingLocation,
    recommendation: "Inspect stdout/stderr and adjust test logic or setup accordingly.",
  };
}

/** Register all tools on the MCP server */
export function registerTools(server: McpServer): void {
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

  server.tool(
    "scan_project",
    `Scan the project and return core testing context:
- package metadata (name, scripts, framework hints)
- source files, test files, and untested source files
- file-count summary and quick coverage ratio

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
        const coverageRatio = structure.sourceFiles.length > 0
          ? Number((((structure.sourceFiles.length - structure.untestedSourceFiles.length) /
            structure.sourceFiles.length) * 100).toFixed(2))
          : null;

        const response = {
          rootDir: structure.rootDir,
          packageJson: {
            found: structure.packageJson.found,
            name: structure.packageJson.name,
            scripts: structure.packageJson.scripts,
            hasJest: structure.packageJson.hasJest,
            hasVitest: structure.packageJson.hasVitest,
            hasTypeScript: structure.packageJson.hasTypeScript,
          },
          sourceFiles: structure.sourceFiles,
          testFiles: structure.testFiles,
          untestedSourceFiles: structure.untestedSourceFiles,
          summary: {
            sourceFiles: structure.sourceFiles.length,
            testFiles: structure.testFiles.length,
            untestedSourceFiles: structure.untestedSourceFiles.length,
            coverageRatioPercent: coverageRatio,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
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
        const scanPath = resolveProjectPath(subdirectory ?? null);
        const projectRoot = getProjectRoot();
        const structure = await scanProjectStructure(scanPath);

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
        const resolvedSource = resolveProjectPath(file_path);
        const selectedConvention = convention ?? inferTestConvention(resolvedSource, structure);
        const resolvedTestPath = test_file_path
          ? resolveProjectPath(test_file_path)
          : deriveTestFilePath(resolvedSource, selectedConvention);

        toolLogger.debug("scaffold paths", { source: resolvedSource, test: resolvedTestPath });

        const analysis = await analyzeSourceFile(resolvedSource);
        const scaffold = generateTestScaffold(analysis, resolvedTestPath, {
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
        const content = await fs.readFile(resolved, "utf-8");
        const lines = content.split("\n");
        const slice = max_lines ? lines.slice(0, max_lines) : lines;
        const result = max_lines && lines.length > max_lines
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
      content: z.string().describe("Full test file content"),
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

        const preflightErrors: string[] = [];
        if (/TODO:/i.test(content)) preflightErrors.push("Content contains TODO placeholders.");
        if (/replace with precise assertion/i.test(content)) {
          preflightErrors.push("Content still has scaffold assertion placeholder text.");
        }
        if (/supply constructor args if needed/i.test(content)) {
          preflightErrors.push("Content still has scaffold constructor placeholder text.");
        }

        const moduleSpecs = new Set<string>();
        for (const m of content.matchAll(/from\s+["']([^"']+)["']/g)) moduleSpecs.add(m[1]);
        for (const m of content.matchAll(/jest\.mock\(\s*["']([^"']+)["']/g)) moduleSpecs.add(m[1]);

        for (const spec of moduleSpecs) {
          if (!spec.startsWith(".")) continue;
          const resolvedFromTest = path.resolve(path.dirname(resolved), spec);
          const exists = await existsAsModuleCandidate(resolvedFromTest);
          if (!exists && relPath.startsWith("tests/")) {
            const stripped = spec.replace(/^(\.\/|\.\.\/)+/, "");
            if (stripped && !stripped.startsWith("src/")) {
              const srcFallback = path.join(getProjectRoot(), "src", stripped);
              const srcFallbackExists = await existsAsModuleCandidate(srcFallback);
              if (srcFallbackExists) {
                preflightErrors.push(
                  `Relative module path "${spec}" does not resolve from "${relPath}". ` +
                  `Did you mean a path under src (for example "../../src/${stripped}")?`
                );
              }
            }
          }
        }

        const targetTestFile = (process.env.TARGET_TEST_FILE || "").trim();
        if (targetTestFile) {
          const sourceBase = path.basename(targetTestFile).replace(/\.(ts|tsx|js|jsx)$/, "");
          const testBase = path.basename(relPath).replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "");
          if (sourceBase && testBase && sourceBase !== testBase) {
            return {
              content: [{
                type: "text",
                text:
                  `Refusing to write test "${relPath}" because TARGET_TEST_FILE is "${targetTestFile}". ` +
                  `Expected test basename "${sourceBase}.test.*" (or *.spec.*).`,
              }],
              isError: true,
            };
          }

          const sourceAbs = resolveProjectPath(targetTestFile);
          const sourceRaw = await fs.readFile(sourceAbs, "utf-8").catch(() => "");
          if (sourceRaw) {
            const typeNames = new Set<string>();
            for (const m of sourceRaw.matchAll(/export\s+interface\s+(\w+)/g)) typeNames.add(m[1]);
            for (const m of sourceRaw.matchAll(/export\s+type\s+(\w+)/g)) typeNames.add(m[1]);

            if (typeNames.size > 0) {
              const importRegex = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
              for (const m of content.matchAll(importRegex)) {
                const imported = m[1]
                  .split(",")
                  .map((s) => s.trim().split(/\s+as\s+/i)[0]?.trim())
                  .filter(Boolean);
                const spec = m[2];
                if (!spec.startsWith(".")) continue;
                const importAbs = path.resolve(path.dirname(resolved), spec);
                if (normalizeWithoutExt(importAbs) === normalizeWithoutExt(sourceAbs)) {
                  const runtimeTypeImports = imported.filter((name) => typeNames.has(name));
                  if (runtimeTypeImports.length > 0) {
                    preflightErrors.push(
                      `Runtime import includes TypeScript-only symbols from target module: ${runtimeTypeImports.join(", ")}. ` +
                      `Use "import type { ... }" for interfaces/types.`
                    );
                  }
                }
              }
            }
          }
        }

        if (preflightErrors.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "TEST_PRECHECK_FAILED",
                filePath: relPath,
                preflightErrors,
              }, null, 2),
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
        const resolvedTest = resolveProjectPath(test_file_path);
        const analysis = await analyzeSourceFile(resolvedSource);

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
  // 10. run_tests
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
  - Coverage summary lines (when coverage: true)`,
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

        let passed = result.exitCode === 0 && !result.timedOut;
        let qualityIssues: Array<{ file: string; issues: string[] }> = [];

        // Quality gate for targeted test-file runs:
        // prevent passing scaffold placeholders as "successful" output.
        if (passed && effectiveTestPathPattern) {
          const candidate = path.isAbsolute(effectiveTestPathPattern)
            ? effectiveTestPathPattern
            : path.join(projectRoot, effectiveTestPathPattern);
          const looksLikeTestFile = /\.(test|spec)\.[jt]sx?$/.test(candidate);
          if (looksLikeTestFile) {
            const stat = await fs.stat(candidate).catch(() => null);
            if (stat?.isFile()) {
              const content = await fs.readFile(candidate, "utf-8");
              const issues: string[] = [];
              if (/TODO:/i.test(content)) issues.push("contains TODO placeholders");
              if (/replace with precise assertion/i.test(content)) {
                issues.push("contains scaffold assertion placeholder text");
              }
              if (/supply constructor args if needed/i.test(content)) {
                issues.push("contains scaffold constructor placeholder text");
              }
              const hasTypeOnlyImport = /^\s*import\s+type\s+/m.test(content);
              const hasRuntimeTargetImport =
                /^\s*import\s+(?!type)(?!\{\s*jest\s*\}\s*from\s+["']@jest\/globals["']).+from\s+["'](?:\.\.\/|\.\/).+["']/m
                  .test(content);
              if (hasTypeOnlyImport && !hasRuntimeTargetImport) {
                issues.push("tests only types/interfaces with no runtime subject under test");
              }
              if (
                /describe\((["'`]).*interface.*\1/i.test(content) &&
                /toHaveProperty\(/i.test(content)
              ) {
                issues.push("contains interface-shape assertions instead of runtime behavior tests");
              }

              if (issues.length > 0) {
                qualityIssues = [{ file: path.relative(projectRoot, candidate), issues }];
                passed = false;
              }
            }
          }
        }

        const failureDiagnostics = passed
          ? null
          : deriveRunTestsFailureDiagnostics({
            timedOut: result.timedOut,
            qualityIssues,
            stderr: result.stderr,
            combinedOutput,
          });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              passed,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              summary: {
                suites: suitesMatch?.[1]?.trim() ?? "unknown",
                tests: testsMatch?.[1]?.trim() ?? "unknown",
                duration: timeMatch?.[1]?.trim() ?? "unknown",
              },
              fileResults,
              qualityIssues,
              failureDiagnostics,
              coverageSummary: coverage ? coverageLines : [],
              // Full output — the agent can read it to diagnose specific failures
              stdout: result.stdout.slice(0, 8000),  // cap at 8 KB
              stderr: result.stderr.slice(0, 4000),
              effectiveTestPathPattern: effectiveTestPathPattern ?? null,
              hint: passed
                ? "All tests passed."
                : qualityIssues.length > 0
                  ? "Quality gate failed: generated tests still contain scaffold placeholders. Replace placeholders with meaningful assertions and rerun run_tests."
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
  // 11. install_test_dependencies
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

  // ───────────────────────────────────────────────────────────────────────────
  // 12. run_command
  // ───────────────────────────────────────────────────────────────────────────
  server.tool(
    "run_command",
    `Run a delivery command for git/gh or execute a script path inside skills/.

Safety guards:
- command mode allows only: git, gh
- path mode allows only scripts under PROJECT_ROOT/skills/
- cwd is resolved relative to PROJECT_ROOT`,
    {
      command: z
        .string()
        .optional()
        .describe('Executable name only (allowed: "git", "gh"). Do not include flags/arguments here.'),
      path: z
        .string()
        .optional()
        .describe('Script path relative to PROJECT_ROOT, e.g. "./skills/git/delivery/verify.sh".'),
      args: z.array(z.string()).optional().default([]),
      cwd: z.string().optional().describe("Optional working directory relative to PROJECT_ROOT."),
      timeout_seconds: z.number().int().min(1).max(300).optional().default(120),
    },
    async ({ command, path: scriptPath, args, cwd, timeout_seconds }) => {
      toolLogger.info("run_command called", { command, scriptPath, cwd });
      const { spawn } = await import("node:child_process");

      try {
        const projectRoot = resolveProjectPath(null);
        const commandMode = typeof command === "string" && command.length > 0;
        const pathMode = typeof scriptPath === "string" && scriptPath.length > 0;

        if ((commandMode && pathMode) || (!commandMode && !pathMode)) {
          return {
            content: [{
              type: "text",
              text: 'Provide exactly one of "command" or "path".',
            }],
            isError: true,
          };
        }

        const resolvedCwd = cwd ? resolveProjectPath(cwd) : projectRoot;
        const cwdStat = await fs.stat(resolvedCwd).catch(() => null);
        if (!cwdStat || !cwdStat.isDirectory()) {
          return {
            content: [{
              type: "text",
              text: `Invalid cwd: ${resolvedCwd}`,
            }],
            isError: true,
          };
        }

        let bin = "";
        let cmdArgs: string[] = [];

        if (commandMode) {
          const normalizedCommand = command!.trim();
          const normalizedArgs = [...args];

          if (/\s/.test(normalizedCommand)) {
            return {
              content: [{
                type: "text",
                text:
                  `Invalid command "${command}". ` +
                  `Set command to only "git" or "gh", and pass all flags/values in args[]. ` +
                  `Example: command="gh", args=["pr","create","--title","My Title","--body","My Body"]`,
              }],
              isError: true,
            };
          }

          if (!(ALLOWED_DELIVERY_COMMANDS as readonly string[]).includes(normalizedCommand)) {
            return {
              content: [{
                type: "text",
                text: `Refused command "${command}". Allowed commands: ${ALLOWED_DELIVERY_COMMANDS.join(", ")}`,
              }],
              isError: true,
            };
          }
          bin = normalizedCommand;
          cmdArgs = normalizedArgs;
        } else {
          const rawScript = scriptPath!;
          const resolvedScriptFromProject = path.isAbsolute(rawScript)
            ? path.resolve(rawScript)
            : path.resolve(projectRoot, rawScript);
          const resolvedScriptFromAgent = path.isAbsolute(rawScript)
            ? path.resolve(rawScript)
            : path.resolve(process.cwd(), rawScript);
          let resolvedScript = resolvedScriptFromProject;

          try {
            await fs.access(resolvedScriptFromProject);
            resolvedScript = resolvedScriptFromProject;
          } catch {
            resolvedScript = resolvedScriptFromAgent;
          }

          const normalizedRoot = projectRoot.replace(/\\/g, "/");
          const normalizedAgentRoot = path.resolve(process.cwd()).replace(/\\/g, "/");
          const normalizedScript = resolvedScript.replace(/\\/g, "/");
          const inProjectSkills = normalizedScript.startsWith(`${normalizedRoot}/skills/`);
          const inAgentSkills = normalizedScript.startsWith(`${normalizedAgentRoot}/skills/`);
          if (!inProjectSkills && !inAgentSkills) {
            return {
              content: [{
                type: "text",
                text: `Refused script outside skills/: ${resolvedScript}`,
              }],
              isError: true,
            };
          }
          await fs.access(resolvedScript);
          bin = "bash";
          cmdArgs = [resolvedScript, ...args];
        }

        const timeoutMs = (timeout_seconds ?? 120) * 1000;
        const result = await new Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }>((resolve) => {
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          let timedOut = false;

          const child = spawn(bin, cmdArgs, {
            cwd: resolvedCwd,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
            shell: false,
          });

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

          child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
          child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              exitCode: code ?? 1,
              stdout: Buffer.concat(out).toString("utf-8"),
              stderr: Buffer.concat(err).toString("utf-8"),
              timedOut,
            });
          });
        });

        const success = result.exitCode === 0 && !result.timedOut;
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                success,
                command: [bin, ...cmdArgs].join(" "),
                cwd: resolvedCwd,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                stdout: result.stdout.slice(0, 12000),
                stderr: result.stderr.slice(0, 6000),
              },
              null,
              2
            ),
          }],
          isError: !success,
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
