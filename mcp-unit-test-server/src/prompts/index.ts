import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Register all prompt templates on the MCP server */
export function registerPrompts(server: McpServer): void {
  // ─── Generate tests for a file ─────────────────────────────────────────────
  server.prompt(
    "generate-tests-for-file",
    "Full workflow prompt: analyze a source file and produce a complete Jest test suite",
    {
      file_path: z.string().describe("Absolute or relative path to the TypeScript/JS source file"),
      project_root: z.string().optional().describe("Project root directory (defaults to cwd)"),
      convention: z
        .enum(["adjacent", "__tests__", "src/__tests__"])
        .optional()
        .describe("Where to place the test file"),
      coverage_goal: z
        .string()
        .optional()
        .describe("Coverage target, e.g. '80% branch coverage'"),
    },
    ({ file_path, project_root, convention, coverage_goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are an expert TypeScript test engineer. Your job is to write a complete, production-quality Jest test suite.

## Task
Generate comprehensive unit tests for the file: **${file_path}**
${project_root ? `Project root: ${project_root}` : ""}
${convention ? `Test file placement convention: ${convention}` : "Convention: __tests__ folder next to the source file"}
${coverage_goal ? `Coverage goal: ${coverage_goal}` : "Coverage goal: ≥80% branch coverage on all exported functions"}

## Workflow (follow in order)
1. Call \`scan_project\` on the project root to understand Jest config, tsconfig, and existing test patterns.
2. Call \`analyze_file\` on \`${file_path}\` to get a structured list of all exports, their signatures, async/sync status, and import dependencies.
3. Read the \`testing-patterns://jest-best-practices\` resource.
4. If the file has HTTP/DB/fs dependencies, also read \`testing-patterns://mocking-guide\`.
5. Call \`generate_test_scaffold\` to get a scaffold with all describe blocks and placeholder tests.
6. For each exported function and class method:
   a. Replace each TODO placeholder with a real, meaningful assertion.
   b. Add at least one happy-path test and one edge-case/error test.
   c. For async functions, add a rejection test.
7. Call \`write_test_file\` to save the final test file to disk.
8. Report back: file path written, functions covered, any open TODOs remaining.

## Quality Checklist
- [ ] Every exported function has ≥1 test
- [ ] Every async function has a rejection/error test
- [ ] All mocks use \`jest.fn()\` or \`jest.mock()\` (no real I/O in unit tests)
- [ ] \`beforeEach\` resets state between tests
- [ ] Tests follow AAA (Arrange / Act / Assert)
- [ ] No \`any\` types in test code
- [ ] Test descriptions clearly state the expected behaviour`,
          },
        },
      ],
    })
  );

  // ─── Review existing test file ──────────────────────────────────────────────
  server.prompt(
    "review-existing-tests",
    "Review an existing test file for quality, coverage gaps, and antipatterns",
    {
      test_file_path: z
        .string()
        .describe("Path to the existing test file (.test.ts)"),
      source_file_path: z
        .string()
        .describe("Path to the corresponding source file being tested"),
    },
    ({ test_file_path, source_file_path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a senior TypeScript engineer reviewing a test suite for quality.

## Files to Review
- Source: **${source_file_path}**
- Tests:  **${test_file_path}**

## Review Workflow
1. Call \`read_file\` on both files to get their full content.
2. Call \`analyze_file\` on the source file to get the list of all exports.
3. Call \`check_coverage_gaps\` with both paths to find untested exports.
4. Evaluate the test file for the following:

## Evaluation Criteria

### Coverage
- Are all exported functions tested?
- Are async functions tested for rejection?
- Are edge cases (empty arrays, nulls, boundary numbers) covered?

### Quality
- Do tests follow AAA (Arrange / Act / Assert)?
- Are test descriptions specific and descriptive?
- Is there any test that could pass vacuously (missing await, wrong assertion)?
- Are mocks properly reset between tests?

### Antipatterns to Flag
- ❌ \`expect(true).toBe(true)\` — vacuous test
- ❌ Tests that rely on execution order
- ❌ Missing \`await\` on async assertions
- ❌ Testing implementation details (e.g., internal private methods via \`any\` casts)
- ❌ Real network/file I/O in unit tests (no mocks)
- ❌ \`console.log\` left in test code

## Output Format
Return a structured review with:
1. **Summary**: Overall quality score (A/B/C/D) and key finding
2. **Coverage Gaps**: List of untested functions/branches
3. **Antipatterns Found**: Line references and how to fix
4. **Suggested Improvements**: Specific code snippets for the top 3 improvements`,
          },
        },
      ],
    })
  );

  // ─── Add edge cases ────────────────────────────────────────────────────────
  server.prompt(
    "add-edge-case-tests",
    "Augment an existing test file with thorough edge case and boundary tests",
    {
      test_file_path: z.string().describe("Path to the test file to augment"),
      source_file_path: z.string().describe("Path to the source file under test"),
      focus_function: z
        .string()
        .optional()
        .describe("Optional: focus edge cases on a specific function name"),
    },
    ({ test_file_path, source_file_path, focus_function }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a TypeScript test engineer specialising in edge-case and boundary testing.

## Goal
Augment the test file **${test_file_path}** with additional edge-case tests for the source file **${source_file_path}**.
${focus_function ? `Focus primarily on the function: \`${focus_function}\`` : "Cover all exported functions."}

## Workflow
1. \`read_file\` both files.
2. \`analyze_file\` on the source to understand parameter types and return types.
3. For each function (or the focused function), generate edge cases for:

### String inputs
- Empty string \`""\`
- Whitespace-only \`"   "\`
- Unicode / emoji characters
- Very long strings (>1000 chars)
- SQL injection patterns (if the function interacts with a DB)

### Number inputs
- \`0\`, \`-0\`, \`NaN\`, \`Infinity\`, \`-Infinity\`
- Maximum safe integer: \`Number.MAX_SAFE_INTEGER\`
- Floating-point precision: \`0.1 + 0.2\`

### Array inputs
- Empty array \`[]\`
- Single-element array
- Array with \`null\` / \`undefined\` entries
- Very large arrays

### Object / nullable inputs
- \`null\`
- \`undefined\`
- Object with extra/missing keys
- Deeply nested objects

### Async edge cases
- Timeout / slow responses (use fake timers)
- Concurrent calls (race conditions)
- Partial failures in parallel operations

4. Write the new tests and append them to the existing describe blocks.
5. Call \`write_test_file\` to save the updated file.`,
          },
        },
      ],
    })
  );
}
