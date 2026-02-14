import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analysisLogger } from "../logger.js";

export interface JestConfig {
  found: boolean;
  configFile: string | null;
  testMatch: string[];
  testEnvironment: string;
  transform: Record<string, string>;
  moduleNameMapper: Record<string, string>;
  setupFilesAfterFramework: string[];
  coverageThreshold: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
}

export interface ProjectStructure {
  rootDir: string;
  packageJson: {
    found: boolean;
    name: string;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
    hasJest: boolean;
    hasVitest: boolean;
    hasTypeScript: boolean;
  };
  jest: JestConfig;
  tsConfig: {
    found: boolean;
    strict: boolean;
    paths: Record<string, string[]>;
    baseUrl: string | null;
  };
  sourceFiles: string[];
  testFiles: string[];
  untestedSourceFiles: string[];
  recommendations: string[];
}

async function safeReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Recursively collect files with given extensions, skipping node_modules */
async function collectFiles(dir: string, exts: string[], results: string[] = []): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, exts, results);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Scan a Node.js/TypeScript project and return its structure */
export async function scanProjectStructure(rootDir: string): Promise<ProjectStructure> {
  const resolvedRoot = path.resolve(rootDir);
  analysisLogger.info("Scanning project structure at {root}", { root: resolvedRoot });

  const structure: ProjectStructure = {
    rootDir: resolvedRoot,
    packageJson: {
      found: false,
      name: "",
      scripts: {},
      dependencies: [],
      devDependencies: [],
      hasJest: false,
      hasVitest: false,
      hasTypeScript: false,
    },
    jest: {
      found: false,
      configFile: null,
      testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
      testEnvironment: "node",
      transform: {},
      moduleNameMapper: {},
      setupFilesAfterFramework: [],
      coverageThreshold: null,
      raw: null,
    },
    tsConfig: {
      found: false,
      strict: false,
      paths: {},
      baseUrl: null,
    },
    sourceFiles: [],
    testFiles: [],
    untestedSourceFiles: [],
    recommendations: [],
  };

  // ─── package.json ─────────────────────────────────────────────────────────────
  const pkgPath = path.join(resolvedRoot, "package.json");
  const pkg = await safeReadJson(pkgPath);
  if (pkg) {
    structure.packageJson.found = true;
    structure.packageJson.name = (pkg.name as string) ?? "";
    structure.packageJson.scripts = (pkg.scripts as Record<string, string>) ?? {};

    const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {});
    const devDeps = Object.keys((pkg.devDependencies as Record<string, string>) ?? {});
    structure.packageJson.dependencies = deps;
    structure.packageJson.devDependencies = devDeps;

    const allDeps = [...deps, ...devDeps];
    structure.packageJson.hasJest = allDeps.some((d) => d === "jest" || d === "@jest/globals");
    structure.packageJson.hasVitest = allDeps.some((d) => d === "vitest");
    structure.packageJson.hasTypeScript = allDeps.some((d) => d === "typescript");

    // Check for inline jest config in package.json
    if (pkg.jest) {
      structure.jest.found = true;
      structure.jest.configFile = "package.json (jest key)";
      structure.jest.raw = pkg.jest as Record<string, unknown>;
      applyJestConfig(structure.jest, pkg.jest as Record<string, unknown>);
    }
  }

  // ─── Jest config files ────────────────────────────────────────────────────────
  const jestConfigCandidates = [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
  ];
  for (const candidate of jestConfigCandidates) {
    try {
      await fs.access(path.join(resolvedRoot, candidate));
      structure.jest.found = true;
      structure.jest.configFile = candidate;
      break;
    } catch {
      // not found
    }
  }

  // ─── tsconfig.json ────────────────────────────────────────────────────────────
  const tsConfigPath = path.join(resolvedRoot, "tsconfig.json");
  const tsConfig = await safeReadJson(tsConfigPath);
  if (tsConfig) {
    structure.tsConfig.found = true;
    const co = (tsConfig.compilerOptions as Record<string, unknown>) ?? {};
    structure.tsConfig.strict = (co.strict as boolean) ?? false;
    structure.tsConfig.paths = (co.paths as Record<string, string[]>) ?? {};
    structure.tsConfig.baseUrl = (co.baseUrl as string) ?? null;
  }

  // ─── Source & test files ──────────────────────────────────────────────────────
  const allFiles = await collectFiles(resolvedRoot, [".ts", ".tsx", ".js", ".jsx"]);

  structure.testFiles = allFiles.filter(
    (f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
  );

  // Files that should never be flagged as "untested":
  // barrel/re-export files (index.ts), well-known config files, type declarations
  const CONFIG_BASENAMES = new Set([
    "jest.config", "jest.setup", "vitest.config",
    "webpack.config", "vite.config", "rollup.config", "esbuild.config",
    "babel.config", "tsconfig", "eslint.config", "prettier.config",
    "tailwind.config", "next.config", "nuxt.config",
  ]);

  structure.sourceFiles = allFiles.filter((f) => {
    if (f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")) return false;
    if (f.includes(".d.ts")) return false;
    return true;
  });

  // Determine which source files have no corresponding test file.
  //
  // A test file "covers" a source file when its stripped base name is
  // EXACTLY equal to the source base name. We use a Set of stripped test
  // bases and compare with === (not .includes()) to avoid false positives
  // like "poweruser.test.ts" wrongly covering "user.ts".
  const testBases = new Set(
    structure.testFiles.map((t) =>
      path.basename(t).replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "")
    )
  );

  for (const src of structure.sourceFiles) {
    const base = path.basename(src).replace(/\.(ts|tsx|js|jsx)$/, "");

    // Skip files that should not have unit tests
    if (base === "index") continue;              // barrel/re-export files
    if (CONFIG_BASENAMES.has(base)) continue;    // known config file names
    if (base.endsWith(".config")) continue;      // any *.config.ts pattern
    if (base.startsWith("_")) continue;          // private/internal convention

    if (!testBases.has(base)) {
      structure.untestedSourceFiles.push(src);
    }
  }

  // ─── Recommendations ──────────────────────────────────────────────────────────
  if (!structure.packageJson.hasJest && !structure.packageJson.hasVitest) {
    structure.recommendations.push(
      "No test framework detected. Install Jest: npm install --save-dev jest @types/jest ts-jest"
    );
  }
  if (!structure.jest.found) {
    structure.recommendations.push(
      "No jest.config.ts found. Create one to control testEnvironment, transform, and coverage."
    );
  }
  if (!structure.tsConfig.strict && structure.packageJson.hasTypeScript) {
    structure.recommendations.push(
      "TypeScript strict mode is disabled. Enable it in tsconfig.json for better type safety in tests."
    );
  }
  if (structure.untestedSourceFiles.length > 0) {
    structure.recommendations.push(
      `${structure.untestedSourceFiles.length} source file(s) have no corresponding test file.`
    );
  }
  if (
    structure.packageJson.hasJest &&
    !structure.packageJson.devDependencies.includes("@types/jest")
  ) {
    structure.recommendations.push("Install @types/jest for TypeScript type support in tests.");
  }
  if (structure.packageJson.hasTypeScript && !structure.packageJson.devDependencies.includes("ts-jest")) {
    structure.recommendations.push(
      "Install ts-jest to run TypeScript tests directly: npm install --save-dev ts-jest"
    );
  }

  analysisLogger.info("Project scan complete", {
    sourceFiles: structure.sourceFiles.length,
    testFiles: structure.testFiles.length,
    untestedFiles: structure.untestedSourceFiles.length,
  });

  return structure;
}

function applyJestConfig(target: JestConfig, raw: Record<string, unknown>): void {
  if (Array.isArray(raw.testMatch)) target.testMatch = raw.testMatch as string[];
  if (typeof raw.testEnvironment === "string") target.testEnvironment = raw.testEnvironment;
  if (raw.transform && typeof raw.transform === "object") {
    target.transform = raw.transform as Record<string, string>;
  }
  if (raw.moduleNameMapper && typeof raw.moduleNameMapper === "object") {
    target.moduleNameMapper = raw.moduleNameMapper as Record<string, string>;
  }
  if (raw.coverageThreshold) {
    target.coverageThreshold = raw.coverageThreshold as Record<string, unknown>;
  }
  target.raw = raw;
}
