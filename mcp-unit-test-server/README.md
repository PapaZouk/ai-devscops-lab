# MCP Unit Test Writing Server

An **MCP (Model Context Protocol) server** that gives AI agents — Claude, Cursor, or your own agent — a full toolkit for writing production-quality **Jest unit tests** for Node.js / TypeScript projects.

---

## What It Does

The server exposes 8 tools, 3 knowledge-base resources, and 3 guided workflow prompts that together enable an AI agent to:

1. **Understand your project** — scan Jest config, tsconfig, and find untested source files.
2. **Deeply analyze any source file** — extract all exported functions, classes, async signatures, and import dependencies.
3. **Generate a complete test scaffold** — describe blocks, AAA-structured test cases, mock stubs.
4. **Identify coverage gaps** — compare source vs existing tests, report untested functions/branches.
5. **Suggest mocking strategies** — return copy-paste-ready mock code for fs, axios, Prisma, Mongoose, AWS SDK, nodemailer, and more.
6. **Generate tailored jest.config.ts** — with ts-jest or @swc/jest, path alias mappers, and coverage thresholds.

---

## Tools Reference

| Tool | Description |
|------|-------------|
| `analyze_file` | Parse all exports, signatures, JSDoc, and suggest mock hints |
| `scan_project` | Understand Jest config, tsconfig, and untested source files |
| `generate_test_scaffold` | Produce a complete Jest test file with describe/it blocks |
| `read_file` | Read any file content for inspection |
| `write_test_file` | Save a generated test file to disk (creates dirs automatically) |
| `check_coverage_gaps` | Diff source vs existing tests to find missing coverage |
| `suggest_mock_strategy` | Return ready-to-use mock snippets for detected dependencies |
| `get_jest_config_template` | Generate a tailored `jest.config.ts` |

## Resources Reference

| URI | Content |
|-----|---------|
| `testing-patterns://jest-best-practices` | AAA pattern, async tests, matchers, antipatterns |
| `testing-patterns://mocking-guide` | ESM mocks, fs, timers, env vars, msw, class constructors |
| `testing-patterns://typescript-testing` | Typed mocks, generics, Zod, Express/Fastify handlers |

## Prompts Reference

| Prompt | Trigger |
|--------|---------|
| `generate-tests-for-file` | Full end-to-end workflow: analyze → scaffold → fill → write |
| `review-existing-tests` | Review quality, find antipatterns, score coverage |
| `add-edge-case-tests` | Augment existing tests with boundary/edge cases |

---

## Installation

### Prerequisites
- Node.js ≥ 22.0.0
- npm ≥ 10.0.0

### Setup

```bash
# Clone or unzip the project
cd mcp-unit-test-server

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### Development (hot-reload, no build step — Node 22+ only)

```bash
npm run dev
```

---

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "unit-test-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-unit-test-server/build/index.js"],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "unit-test-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-unit-test-server/build/index.js"]
    }
  }
}
```

### Custom Agent (Vercel AI SDK)

```typescript
import { experimental_createMCPClient } from "ai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = await experimental_createMCPClient({
  transport: new StdioClientTransport({
    command: "node",
    args: ["/path/to/mcp-unit-test-server/build/index.js"],
  }),
});

const tools = await client.tools(); // returns all 8 tools as Vercel AI SDK tools
```

---

## Usage Examples

### Example 1 — Generate tests for a new file

Invoke the `generate-tests-for-file` prompt in Claude Desktop or Cursor:

> **User:** Use the `generate-tests-for-file` prompt on `src/services/userService.ts`

The agent will:
1. `scan_project(".")` — understand jest config and existing tests
2. `analyze_file("src/services/userService.ts")` — extract all exports
3. Read `testing-patterns://jest-best-practices`
4. `generate_test_scaffold(...)` — produce a full test scaffold
5. Fill in real assertions for each function
6. `write_test_file(...)` — save to `src/__tests__/userService.test.ts`

### Example 2 — Find coverage gaps

> **User:** Check what's missing in my existing tests for `src/utils/dateUtils.ts`

The agent calls:
```
check_coverage_gaps({
  source_file_path: "src/utils/dateUtils.ts",
  test_file_path: "src/__tests__/dateUtils.test.ts"
})
```

Returns a structured report of untested functions, missing rejection tests, and edge cases to add.

### Example 3 — Get mock strategy for a file with DB access

> **User:** What's the best way to mock dependencies in `src/repositories/userRepo.ts`?

The agent calls:
```
suggest_mock_strategy({ file_path: "src/repositories/userRepo.ts" })
```

Returns ready-to-paste mock code for Prisma (or whichever ORM is detected).

### Example 4 — Generate jest.config.ts

> **User:** Create a jest.config.ts for my TypeScript ESM project

```
get_jest_config_template({
  project_root: ".",
  use_swc: false,
  test_environment: "node",
  coverage_threshold: 80
})
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |

---

## Architecture

```
src/
├── index.ts                  ← MCP server entry point (STDIO transport)
├── logger.ts                 ← LogTape setup — always writes to stderr (never stdout)
├── tools/
│   └── index.ts              ← All 8 tool registrations
├── resources/
│   └── index.ts              ← 3 knowledge-base resources (best practices guides)
├── prompts/
│   └── index.ts              ← 3 guided workflow prompts
└── utils/
    ├── sourceAnalyzer.ts     ← Parse TypeScript/JS files for exports & signatures
    ├── testGenerator.ts      ← Generate Jest test scaffolds from analysis
    └── projectScanner.ts     ← Scan project structure, Jest config, tsconfig
```

### Key Design Decisions

- **STDIO transport only** — keeps the server simple and compatible with all MCP hosts.
- **No stdout** — `@logtape/logtape` is configured to write exclusively to `stderr`, which is essential under STDIO transport where stdout is the JSON-RPC channel.
- **`isError: true`** — all tool failures return `{ isError: true }` rather than throwing, giving the AI agent structured error information to self-correct.
- **Regex-based analysis** — no AST parser dependency. This keeps installation simple while handling the most common patterns; complex files benefit from the AI agent reading them directly via `read_file`.

---

## Development

```bash
# Type-check without building
npm run typecheck

# Watch mode (Node 22 native TS stripping)
npm run dev

# Build for production
npm run build
npm start
```

---

## License

MIT
