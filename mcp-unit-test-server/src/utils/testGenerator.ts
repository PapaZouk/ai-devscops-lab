import * as path from "node:path";
import type { SourceFileAnalysis, FunctionSignature, ClassDefinition } from "./sourceAnalyzer.js";

export interface TestScaffoldOptions {
  testFramework: "jest" | "vitest";
  moduleStyle: "esm" | "commonjs";
  includeEdgeCases: boolean;
  includeTypeChecks: boolean;
  mockStrategy: "auto" | "manual" | "none";
}

const DEFAULT_OPTIONS: TestScaffoldOptions = {
  testFramework: "jest",
  moduleStyle: "esm",
  includeEdgeCases: true,
  includeTypeChecks: true,
  mockStrategy: "auto",
};

/** Build the import statement for the file under test */
function buildImport(analysis: SourceFileAnalysis, testFilePath: string): string {
  const sourceDir = path.dirname(analysis.filePath);
  const testDir = path.dirname(testFilePath);
  let relativePath = path.relative(testDir, analysis.filePath);

  // Strip extension for clean imports
  relativePath = relativePath.replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!relativePath.startsWith(".")) relativePath = "./" + relativePath;

  const namedExports = [
    ...analysis.exports.functions.filter((f) => !f.isDefault).map((f) => f.name),
    ...analysis.exports.classes.filter((c) => !c.isDefault).map((c) => c.name),
    ...analysis.exports.constants.map((c) => c.name),
  ];

  const parts: string[] = [];
  if (analysis.hasDefaultExport) {
    const defaultName =
      analysis.exports.functions.find((f) => f.isDefault)?.name ??
      analysis.exports.classes.find((c) => c.isDefault)?.name ??
      "defaultExport";
    if (namedExports.length > 0) {
      parts.push(`import ${defaultName}, { ${namedExports.join(", ")} } from "${relativePath}";`);
    } else {
      parts.push(`import ${defaultName} from "${relativePath}";`);
    }
  } else if (namedExports.length > 0) {
    parts.push(`import { ${namedExports.join(", ")} } from "${relativePath}";`);
  } else {
    parts.push(`import * as module from "${relativePath}";`);
  }

  return parts.join("\n");
}

/** Generate mock suggestions based on imports */
function buildMockSection(analysis: SourceFileAnalysis): string {
  const mocks: string[] = [];

  for (const imp of analysis.imports) {
    if (imp.includes("node:fs") || imp.includes("'fs'") || imp.includes('"fs"')) {
      mocks.push(`jest.mock("node:fs/promises");`);
    }
    if (imp.includes("axios")) {
      mocks.push(`jest.mock("axios");`);
      mocks.push(`// import axios from "axios";\n// const mockedAxios = axios as jest.Mocked<typeof axios>;`);
    }
    if (imp.includes("prisma")) {
      mocks.push(
        `// Mock Prisma client\n// jest.mock("@prisma/client");\n// const prismaMock = { user: { findUnique: jest.fn(), create: jest.fn() } };`
      );
    }
  }

  return mocks.length > 0 ? "\n// ─── Mocks ───────────────────────────────────────────────────\n" + mocks.join("\n") : "";
}

/** Generate test cases for a single function */
function generateFunctionTests(fn: FunctionSignature, _options: TestScaffoldOptions): string {
  const cases: string[] = [];
  const callArgs = fn.params.length > 0
    ? fn.params.map((p) => {
        const name = p.split(":")[0].trim().replace("?", "");
        return `/* ${name} */`;
      }).join(", ")
    : "";

  const awaitKeyword = fn.isAsync ? "await " : "";
  const call = `${awaitKeyword}${fn.name}(${callArgs})`;
  const testPrefix = fn.isAsync ? "async " : "";

  cases.push(
    `  it("should return expected result for valid input", ${testPrefix}() => {`,
    `    // Arrange`,
    `    ${fn.params.map((p) => {
      const [pName, pType] = p.split(":").map(s => s.trim().replace("?", ""));
      const sampleValue = getSampleValue(pType ?? "unknown");
      return `const ${pName} = ${sampleValue};`;
    }).join("\n    ")}`,
    ``,
    `    // Act`,
    `    const result = ${call};`,
    ``,
    `    // Assert`,
    `    expect(result).toBeDefined();`,
    `    // TODO: replace with precise assertion`,
    `  });`,
    ``
  );

  if (fn.isAsync) {
    cases.push(
      `  it("should handle async rejection gracefully", async () => {`,
      `    // TODO: mock a dependency to throw`,
      `    // await expect(${fn.name}(/* bad args */)).rejects.toThrow("expected error");`,
      `  });`,
      ``
    );
  }

  if (fn.params.some((p) => p.includes("string"))) {
    cases.push(
      `  it("should handle empty string input", ${testPrefix}() => {`,
      `    // expect(() => ${fn.name}(${fn.params.map(() => '""').join(", ")})).toThrow();`,
      `    // OR: expect(${awaitKeyword}${fn.name}(${fn.params.map(() => '""').join(", ")})).toEqual(/* expected */);`,
      `  });`,
      ``
    );
  }

  if (fn.params.some((p) => p.includes("number"))) {
    cases.push(
      `  it("should handle boundary numbers (0, negative, NaN)", ${testPrefix}() => {`,
      `    // expect(${awaitKeyword}${fn.name}(${fn.params.map(() => "0").join(", ")})).toBe(/* expected */);`,
      `    // expect(() => ${fn.name}(${fn.params.map(() => "NaN").join(", ")})).toThrow();`,
      `  });`,
      ``
    );
  }

  if (fn.params.some((p) => p.toLowerCase().includes("array") || p.includes("[]"))) {
    cases.push(
      `  it("should handle empty array input", ${testPrefix}() => {`,
      `    // expect(${awaitKeyword}${fn.name}([])).toEqual(/* expected */);`,
      `  });`,
      ``
    );
  }

  return cases.join("\n");
}

/** Generate test cases for a class */
function generateClassTests(cls: ClassDefinition, _options: TestScaffoldOptions): string {
  const lines: string[] = [
    `describe("${cls.name}", () => {`,
    `  let instance: ${cls.name};`,
    ``,
    `  beforeEach(() => {`,
    `    // TODO: supply constructor args if needed`,
    `    instance = new ${cls.name}();`,
    `  });`,
    ``,
    `  afterEach(() => {`,
    `    jest.clearAllMocks();`,
    `  });`,
    ``,
    `  describe("constructor", () => {`,
    `    it("should create a valid instance", () => {`,
    `      expect(instance).toBeInstanceOf(${cls.name});`,
    `    });`,
    `  });`,
    ``,
  ];

  for (const method of cls.methods) {
    const awaitKeyword = method.isAsync ? "await " : "";
    const testPrefix = method.isAsync ? "async " : "";
    const callArgs = method.params.map((p) => {
      const [pName, pType] = p.split(":").map(s => s.trim());
      return getSampleValue(pType ?? "unknown");
    }).join(", ");

    lines.push(
      `  describe("${method.name}()", () => {`,
      `    it("should behave correctly for valid input", ${testPrefix}() => {`,
      `      // Arrange`,
      `      // Act`,
      `      const result = ${awaitKeyword}instance.${method.name}(${callArgs});`,
      `      // Assert`,
      `      expect(result).toBeDefined();`,
      `      // TODO: replace with precise assertion`,
      `    });`,
      ``,
      `    it("should handle invalid or edge-case input", ${testPrefix}() => {`,
      `      // TODO: supply invalid args and assert throw or graceful return`,
      `    });`,
      `  });`,
      ``
    );
  }

  lines.push(`});`);
  return lines.join("\n");
}

/** Return a sensible placeholder value for a TypeScript type string */
function getSampleValue(type: string): string {
  const t = type.toLowerCase().trim();
  if (t.includes("string")) return '"test-value"';
  if (t.includes("number")) return "42";
  if (t.includes("boolean")) return "true";
  if (t.includes("[]") || t.includes("array")) return "[]";
  if (t.includes("object") || t.includes("{")) return "{}";
  if (t === "void" || t === "inferred" || t === "unknown") return "/* value */";
  return "/* value */";
}

/** Generate a full Jest test scaffold from a source file analysis */
export function generateTestScaffold(
  analysis: SourceFileAnalysis,
  testFilePath: string,
  options: Partial<TestScaffoldOptions> = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const isTs = analysis.language === "typescript";

  const header = [
    `/**`,
    ` * Unit tests for: ${path.basename(analysis.filePath)}`,
    ` * Generated by MCP Unit Test Server`,
    ` * `,
    ` * Coverage targets:`,
    ...analysis.exports.functions.map((f) => ` *   ✦ ${f.name}()`),
    ...analysis.exports.classes.map((c) => ` *   ✦ class ${c.name}`),
    ` */`,
    ``,
  ].join("\n");

  const importSection = buildImport(analysis, testFilePath);
  const mockSection = buildMockSection(analysis);

  const testBlocks: string[] = [];

  // ─── Standalone function tests ──────────────────────────────────────────────
  const standaloneFns = analysis.exports.functions.filter(
    (f) => !analysis.exports.classes.some((c) => c.methods.some((m) => m.name === f.name))
  );

  if (standaloneFns.length > 0) {
    for (const fn of standaloneFns) {
      testBlocks.push(
        `describe("${fn.name}()", () => {`,
        generateFunctionTests(fn, opts),
        `});`,
        ``
      );
    }
  }

  // ─── Class tests ─────────────────────────────────────────────────────────────
  for (const cls of analysis.exports.classes) {
    testBlocks.push(generateClassTests(cls, opts), ``);
  }

  // ─── Constants sanity checks ─────────────────────────────────────────────────
  if (analysis.exports.constants.length > 0) {
    testBlocks.push(
      `describe("Module constants", () => {`,
      ...analysis.exports.constants.map(
        (c) =>
          `  it("${c.name} should have correct value", () => {\n    expect(${c.name}).toBeDefined();\n    // TODO: assert exact value\n  });\n`
      ),
      `});`,
      ``
    );
  }

  const setupSection = [
    ``,
    `// ─── Global test setup ───────────────────────────────────────────────────────`,
    `beforeAll(() => {`,
    `  // One-time setup for the entire test suite`,
    `});`,
    ``,
    `afterAll(() => {`,
    `  // One-time teardown`,
    `});`,
    ``,
  ].join("\n");

  const body = [importSection, mockSection, setupSection, ...testBlocks].join("\n");
  const needsJestGlobalsImport =
    opts.testFramework === "jest" &&
    opts.moduleStyle === "esm" &&
    /\bjest\./.test(body) &&
    !/from ["']@jest\/globals["']/.test(body);

  const importPrelude = [importSection];
  if (needsJestGlobalsImport) {
    importPrelude.push(`import { jest } from "@jest/globals";`);
  }

  return [header, ...importPrelude, mockSection, setupSection, ...testBlocks].join("\n");
}

/** Derive the canonical test file path from a source file path */
export function deriveTestFilePath(
  sourcePath: string,
  convention: "adjacent" | "__tests__" | "src/__tests__" | "tests" = "__tests__"
): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath).replace(/\.(ts|tsx|js|jsx)$/, "");
  const ext = sourcePath.endsWith(".tsx") || sourcePath.endsWith(".jsx") ? ".tsx" : ".ts";

  switch (convention) {
    case "adjacent":
      return path.join(dir, `${base}.test${ext}`);
    case "__tests__":
      return path.join(dir, "__tests__", `${base}.test${ext}`);
    case "src/__tests__": {
      // Walk up to find src/ and place tests there
      const srcIndex = dir.split(path.sep).lastIndexOf("src");
      if (srcIndex !== -1) {
        const projectRoot = dir.split(path.sep).slice(0, srcIndex).join(path.sep);
        return path.join(projectRoot, "src", "__tests__", `${base}.test${ext}`);
      }
      return path.join(dir, "__tests__", `${base}.test${ext}`);
    }
    case "tests": {
      // Keep project structure: mirror source paths under top-level tests/
      // (e.g. src/api/authRoutes.ts -> tests/api/authRoutes.test.ts).
      const parts = sourcePath.split(path.sep);
      const srcIndex = parts.lastIndexOf("src");
      if (srcIndex !== -1) {
        const projectRoot = parts.slice(0, srcIndex).join(path.sep);
        const relUnderSrc = parts.slice(srcIndex + 1, parts.length - 1);
        return path.join(projectRoot, "tests", ...relUnderSrc, `${base}.test${ext}`);
      }

      const parent = path.dirname(sourcePath);
      return path.join(parent, "..", "tests", `${base}.test${ext}`);
    }
  }
}
