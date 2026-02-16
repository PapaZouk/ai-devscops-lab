import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analysisLogger } from "../logger.js";

export interface FunctionSignature {
  name: string;
  isAsync: boolean;
  isExported: boolean;
  isDefault: boolean;
  params: string[];
  returnType: string;
  jsDocComment: string | null;
  lineNumber: number;
}

export interface ClassDefinition {
  name: string;
  isExported: boolean;
  isDefault: boolean;
  methods: FunctionSignature[];
  properties: string[];
  extendsClass: string | null;
  implementsInterfaces: string[];
  lineNumber: number;
}

export interface InterfaceDefinition {
  name: string;
  isExported: boolean;
  properties: string[];
  lineNumber: number;
}

export interface TypeDefinition {
  name: string;
  isExported: boolean;
  definition: string;
  lineNumber: number;
}

export interface SourceFileAnalysis {
  filePath: string;
  language: "typescript" | "javascript";
  imports: string[];
  exports: {
    functions: FunctionSignature[];
    classes: ClassDefinition[];
    interfaces: InterfaceDefinition[];
    types: TypeDefinition[];
    constants: Array<{ name: string; type: string; lineNumber: number }>;
  };
  hasDefaultExport: boolean;
  estimatedComplexity: "low" | "medium" | "high";
  suggestions: string[];
}

/** Extract JSDoc comment immediately preceding a given line */
function extractJsDoc(lines: string[], lineIndex: number): string | null {
  const commentLines: string[] = [];
  let i = lineIndex - 1;

  while (i >= 0 && (lines[i].trim().startsWith("*") || lines[i].trim() === "*/")) {
    commentLines.unshift(lines[i].trim());
    i--;
  }
  if (i >= 0 && lines[i].trim().startsWith("/**")) {
    commentLines.unshift(lines[i].trim());
  }

  return commentLines.length > 0 ? commentLines.join("\n") : null;
}

/** Analyze a TypeScript/JavaScript source file */
export async function analyzeSourceFile(filePath: string): Promise<SourceFileAnalysis> {
  const resolvedPath = path.resolve(filePath);
  analysisLogger.debug("Analyzing source file: {path}", { path: resolvedPath });

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const lines = content.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const language: "typescript" | "javascript" =
    ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";

  const analysis: SourceFileAnalysis = {
    filePath: resolvedPath,
    language,
    imports: [],
    exports: { functions: [], classes: [], interfaces: [], types: [], constants: [] },
    hasDefaultExport: false,
    estimatedComplexity: "low",
    suggestions: [],
  };

  // ─── Imports ─────────────────────────────────────────────────────────────────
  const importRegex = /^import\s+.+from\s+['"].+['"]/;
  for (const line of lines) {
    if (importRegex.test(line.trim())) {
      analysis.imports.push(line.trim());
    }
  }

  // ─── Exported functions ───────────────────────────────────────────────────────
  const funcRegex =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*(.+?))?\s*\{/;
  const arrowFuncExportRegex =
    /^export\s+(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Standard function declarations
    const funcMatch = line.match(funcRegex);
    if (funcMatch) {
      const isExported = line.startsWith("export");
      const isDefault = line.includes("export default");
      const isAsync = line.includes("async");
      const name = funcMatch[1];
      const paramsRaw = funcMatch[3] ?? "";
      const returnType = funcMatch[4]?.trim() ?? "void";
      const params = paramsRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      if (isExported || isDefault) {
        analysis.exports.functions.push({
          name,
          isAsync,
          isExported,
          isDefault,
          params,
          returnType,
          jsDocComment: extractJsDoc(lines, i),
          lineNumber: i + 1,
        });
        if (isDefault) analysis.hasDefaultExport = true;
      }
    }

    // Arrow function exports
    const arrowMatch = line.match(arrowFuncExportRegex);
    if (arrowMatch) {
      const name = arrowMatch[1];
      const isAsync = line.includes("async");
      analysis.exports.functions.push({
        name,
        isAsync,
        isExported: true,
        isDefault: false,
        params: [],
        returnType: "inferred",
        jsDocComment: extractJsDoc(lines, i),
        lineNumber: i + 1,
      });
    }

    // export default function / export default <identifier>
    if (line.match(/^export\s+default\s+(?!class|function)/)) {
      analysis.hasDefaultExport = true;
    }
  }

  // ─── Exported classes ─────────────────────────────────────────────────────────
  const classRegex = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/;
  const methodRegex = /^(?:(?:public|private|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*(.+?))?\s*\{?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const classMatch = line.match(classRegex);
    if (classMatch) {
      const className = classMatch[1];
      const extendsClass = classMatch[2] ?? null;
      const implementsRaw = classMatch[3] ?? "";
      const implementsInterfaces = implementsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const classDef: ClassDefinition = {
        name: className,
        isExported: true,
        isDefault: line.includes("export default"),
        methods: [],
        properties: [],
        extendsClass,
        implementsInterfaces,
        lineNumber: i + 1,
      };

      // Scan class body for methods and properties
      let braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      let j = i + 1;
      while (j < lines.length && braceDepth > 0) {
        const innerLine = lines[j];
        braceDepth += (innerLine.match(/\{/g) ?? []).length;
        braceDepth -= (innerLine.match(/\}/g) ?? []).length;

        const methodMatch = innerLine.trim().match(methodRegex);
        if (
          methodMatch &&
          !innerLine.trim().startsWith("//") &&
          !["constructor", "get", "set"].includes(methodMatch[1])
        ) {
          const methodName = methodMatch[1];
          const isAsync = innerLine.includes("async");
          const params = (methodMatch[2] ?? "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          classDef.methods.push({
            name: methodName,
            isAsync,
            isExported: false,
            isDefault: false,
            params,
            returnType: methodMatch[3]?.trim() ?? "void",
            jsDocComment: null,
            lineNumber: j + 1,
          });
        }

        // Properties (TypeScript typed class fields)
        const propMatch = innerLine
          .trim()
          .match(/^(?:(?:public|private|protected|readonly|static)\s+)+(\w+)\s*(?:[!?]:)/);
        if (propMatch) {
          classDef.properties.push(propMatch[1]);
        }
        j++;
      }

      if (classDef.isDefault) analysis.hasDefaultExport = true;
      analysis.exports.classes.push(classDef);
    }
  }

  // ─── Interfaces ───────────────────────────────────────────────────────────────
  if (language === "typescript") {
    const ifaceRegex = /^export\s+interface\s+(\w+)/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const ifaceMatch = line.match(ifaceRegex);
      if (ifaceMatch) {
        const properties: string[] = [];
        let braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        let j = i + 1;
        while (j < lines.length && braceDepth > 0) {
          const innerLine = lines[j].trim();
          braceDepth += (innerLine.match(/\{/g) ?? []).length;
          braceDepth -= (innerLine.match(/\}/g) ?? []).length;
          if (innerLine && !innerLine.startsWith("//") && innerLine !== "{" && innerLine !== "}") {
            properties.push(innerLine.replace(/;$/, "").trim());
          }
          j++;
        }
        analysis.exports.interfaces.push({
          name: ifaceMatch[1],
          isExported: true,
          properties,
          lineNumber: i + 1,
        });
      }
    }

    // Types
    const typeRegex = /^export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=\s*(.+)/;
    for (let i = 0; i < lines.length; i++) {
      const typeMatch = lines[i].trim().match(typeRegex);
      if (typeMatch) {
        analysis.exports.types.push({
          name: typeMatch[1],
          isExported: true,
          definition: typeMatch[2].trim(),
          lineNumber: i + 1,
        });
      }
    }
  }

  // ─── Exported constants ───────────────────────────────────────────────────────
  const constRegex = /^export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*([^=]+))?\s*=/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(constRegex);
    if (match && !arrowFuncExportRegex.test(lines[i].trim())) {
      analysis.exports.constants.push({
        name: match[1],
        type: match[2]?.trim() ?? "inferred",
        lineNumber: i + 1,
      });
    }
  }

  // ─── Complexity estimation ─────────────────────────────────────────────────────
  const totalExports =
    analysis.exports.functions.length +
    analysis.exports.classes.length * 2 +
    analysis.exports.constants.length;

  analysis.estimatedComplexity =
    totalExports > 15 ? "high" : totalExports > 5 ? "medium" : "low";

  // ─── Suggestions ──────────────────────────────────────────────────────────────
  if (analysis.exports.functions.some((f) => f.isAsync)) {
    analysis.suggestions.push(
      "File contains async functions — use async/await in tests and consider jest.useFakeTimers() for timeout-sensitive logic."
    );
  }
  if (analysis.exports.classes.length > 0) {
    analysis.suggestions.push(
      "File exports classes — create a fresh instance in beforeEach() to avoid state leakage between tests."
    );
  }
  if (analysis.imports.some((i) => i.includes("fs") || i.includes("path"))) {
    analysis.suggestions.push(
      "File uses filesystem modules — mock with jest.mock('node:fs/promises') or use memfs for deterministic tests."
    );
  }
  if (analysis.imports.some((i) => i.includes("fetch") || i.includes("axios") || i.includes("http"))) {
    analysis.suggestions.push(
      "File makes HTTP requests — use jest.mock() or msw (Mock Service Worker) to intercept network calls."
    );
  }
  if (analysis.imports.some((i) => i.includes("database") || i.includes("prisma") || i.includes("typeorm") || i.includes("mongoose"))) {
    analysis.suggestions.push(
      "File uses a database client — mock the client module and verify calls with jest.fn() spies."
    );
  }

  analysisLogger.info("Analysis complete for {path}", {
    path: resolvedPath,
    functions: analysis.exports.functions.length,
    classes: analysis.exports.classes.length,
    complexity: analysis.estimatedComplexity,
  });

  return analysis;
}
