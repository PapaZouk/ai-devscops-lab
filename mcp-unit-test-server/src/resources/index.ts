import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const JEST_BEST_PRACTICES = `# Jest Unit Testing Best Practices for Node.js / TypeScript

## Test File Naming & Structure
- Place tests in \`__tests__/\` folders OR alongside source as \`*.test.ts\`
- Name test files: \`featureName.test.ts\` (never \`featureName.spec.js\`)
- One describe block per exported unit (function or class)
- Nest inner describe blocks for logical groupings (e.g., "when input is valid")

## The AAA Pattern (Arrange, Act, Assert)
Every test should follow three clear phases:
\`\`\`ts
it("calculates total with tax", () => {
  // Arrange
  const price = 100;
  const taxRate = 0.2;

  // Act
  const result = calculateTotal(price, taxRate);

  // Assert
  expect(result).toBe(120);
});
\`\`\`

## describe / it Naming Conventions
- describe: name the unit under test — \`describe("formatDate", () => {}\`
- it: state the expected behaviour — \`it("returns ISO string for valid Date")\`
- Avoid vague labels: ❌ "it works", ❌ "it should do something"

## Async Tests
\`\`\`ts
// Always await async functions — never forget or the test passes vacuously
it("fetches user by id", async () => {
  const user = await getUser("user-123");
  expect(user.id).toBe("user-123");
});

// Test rejections with rejects.toThrow
it("rejects for unknown id", async () => {
  await expect(getUser("bad-id")).rejects.toThrow("User not found");
});
\`\`\`

## Mocking Strategies
### jest.fn() — simple spy / stub
\`\`\`ts
const mockSave = jest.fn().mockResolvedValue({ id: "abc" });
\`\`\`

### jest.mock() — module replacement
\`\`\`ts
jest.mock("../services/emailService");
import { sendEmail } from "../services/emailService";
const mockedSend = sendEmail as jest.MockedFunction<typeof sendEmail>;
mockedSend.mockResolvedValue(undefined);
\`\`\`

### jest.spyOn() — partial mock without replacing the module
\`\`\`ts
const spy = jest.spyOn(userRepository, "findById").mockResolvedValue(fakeUser);
// ... run test ...
expect(spy).toHaveBeenCalledWith("user-123");
spy.mockRestore(); // clean up
\`\`\`

## Setup & Teardown
\`\`\`ts
describe("UserService", () => {
  let service: UserService;

  beforeEach(() => {
    service = new UserService();   // fresh instance every test
    jest.clearAllMocks();          // reset call counts & return values
  });

  afterAll(() => {
    // close DB connections, stop servers, etc.
  });
});
\`\`\`

## Common Matchers Reference
| Matcher | Use for |
|---------|---------|
| \`toBe(val)\` | Primitive equality (===) |
| \`toEqual(obj)\` | Deep structural equality |
| \`toStrictEqual(obj)\` | Deep equality + prototype check |
| \`toBeNull() / toBeUndefined()\` | Nullish checks |
| \`toThrow("message")\` | Synchronous error |
| \`rejects.toThrow()\` | Async rejection |
| \`toHaveBeenCalledWith(args)\` | Mock call assertion |
| \`toHaveBeenCalledTimes(n)\` | Call count |
| \`expect.arrayContaining([...])\` | Partial array match |
| \`expect.objectContaining({...})\` | Partial object match |
| \`toMatchSnapshot()\` | Snapshot comparison |

## What NOT to Test
- Private/internal implementation details
- Third-party library internals
- Types/interfaces (TypeScript handles this at compile time)
- Framework wiring that's already tested by the framework itself

## Coverage Targets
- Aim for **≥80% branch coverage** on business logic
- 100% coverage is not always the goal — test meaningful behaviour
- Use \`--coverage --coverageThreshold\` in CI to enforce minimums

## TypeScript-Specific Tips
- Type your mocks: \`jest.MockedFunction<typeof fn>\`
- Use \`jest.Mocked<T>\` for mocked class instances
- Import types separately: \`import type { User } from "./models"\`
- Prefer \`ts-jest\` or \`@swc/jest\` transforms over Babel for better TS support
`;

const MOCKING_GUIDE = `# Comprehensive Mocking Guide for Jest + TypeScript

## 1. Mocking ES Modules (ESM)
\`\`\`ts
// jest.config.ts — enable experimental VM modules
export default {
  extensionsToTreatAsEsm: [".ts"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { useESM: true }] },
};

// In test file
jest.mock("../utils/httpClient.js");
import { get } from "../utils/httpClient.js";
const mockedGet = get as jest.MockedFunction<typeof get>;
\`\`\`

## 2. Mocking node:fs/promises
\`\`\`ts
import { readFile, writeFile } from "node:fs/promises";
jest.mock("node:fs/promises");

const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;
mockedReadFile.mockResolvedValue(Buffer.from("file contents"));
\`\`\`

## 3. Mocking timers
\`\`\`ts
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

it("debounces correctly", () => {
  const fn = jest.fn();
  debounce(fn, 300)();
  expect(fn).not.toHaveBeenCalled();
  jest.advanceTimersByTime(300);
  expect(fn).toHaveBeenCalledTimes(1);
});
\`\`\`

## 4. Mocking environment variables
\`\`\`ts
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv, DATABASE_URL: "postgres://test" };
});
afterEach(() => {
  process.env = originalEnv;
});
\`\`\`

## 5. Manual mocks (__mocks__ folder)
Create \`src/__mocks__/emailService.ts\`:
\`\`\`ts
export const sendEmail = jest.fn().mockResolvedValue(undefined);
export const sendBulkEmail = jest.fn().mockResolvedValue({ sent: 0 });
\`\`\`
Then in tests: \`jest.mock("../services/emailService");\` auto-uses the manual mock.

## 6. Mocking class constructors
\`\`\`ts
jest.mock("../db/DatabaseClient");
import { DatabaseClient } from "../db/DatabaseClient";
const MockDB = DatabaseClient as jest.MockedClass<typeof DatabaseClient>;

MockDB.prototype.query = jest.fn().mockResolvedValue([]);
\`\`\`

## 7. Network mocking with msw (recommended for HTTP)
\`\`\`ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

const server = setupServer(
  http.get("https://api.example.com/users/:id", ({ params }) => {
    return HttpResponse.json({ id: params.id, name: "Alice" });
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
\`\`\`
`;

const TYPESCRIPT_TESTING_PATTERNS = `# TypeScript-Specific Testing Patterns

## Typed Mocks
\`\`\`ts
import type { UserRepository } from "./repositories/UserRepository";

// jest.Mocked<T> types all methods as jest.MockedFunction
const mockRepo: jest.Mocked<UserRepository> = {
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
\`\`\`

## Testing Generic Functions
\`\`\`ts
// Source
export function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

// Test
it("returns first element of number array", () => {
  expect(first([1, 2, 3])).toBe(1);
});
it("returns undefined for empty array", () => {
  expect(first([])).toBeUndefined();
});
\`\`\`

## Testing Discriminated Unions
\`\`\`ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

it("returns ok result on success", () => {
  const result = divide(10, 2);
  if (!result.ok) throw new Error("Expected ok result");
  expect(result.value).toBe(5);
});

it("returns error result on division by zero", () => {
  const result = divide(10, 0);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected error result");
  expect(result.error).toMatch(/zero/i);
});
\`\`\`

## Testing with Zod Schemas
\`\`\`ts
import { z } from "zod";
import { UserSchema } from "../schemas/user";

it("validates correct user shape", () => {
  const input = { id: "1", name: "Alice", email: "a@b.com" };
  expect(() => UserSchema.parse(input)).not.toThrow();
});

it("throws on missing required field", () => {
  expect(() => UserSchema.parse({ id: "1" })).toThrow(z.ZodError);
});
\`\`\`

## Testing Express/Fastify Route Handlers
\`\`\`ts
import { createApp } from "../app";
import request from "supertest";

describe("GET /users/:id", () => {
  const app = createApp();

  it("returns 200 for existing user", async () => {
    const res = await request(app).get("/users/123");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "123" });
  });

  it("returns 404 for missing user", async () => {
    const res = await request(app).get("/users/missing");
    expect(res.status).toBe(404);
  });
});
\`\`\`

## jest.config.ts Template (TypeScript Projects)
\`\`\`ts
import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",     // fix ESM import extensions
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      tsconfig: { strict: true },
    }],
  },
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  coverageThreshold: {
    global: { lines: 80, branches: 75, functions: 80 },
  },
};

export default config;
\`\`\`
`;

/** Register all knowledge-base resources on the MCP server */
export function registerResources(server: McpServer): void {
  server.resource(
    "testing-patterns://jest-best-practices",
    "Comprehensive Jest best practices for Node.js and TypeScript projects",
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          text: JEST_BEST_PRACTICES,
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.resource(
    "testing-patterns://mocking-guide",
    "Detailed guide for mocking dependencies with Jest in TypeScript",
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          text: MOCKING_GUIDE,
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.resource(
    "testing-patterns://typescript-testing",
    "TypeScript-specific testing patterns: typed mocks, generics, Zod, HTTP handlers",
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          text: TYPESCRIPT_TESTING_PATTERNS,
          mimeType: "text/markdown",
        },
      ],
    })
  );
}
