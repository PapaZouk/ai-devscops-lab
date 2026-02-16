# Unit Testing Skill Guide

## Purpose
Create reliable unit tests that run successfully in CI without changing unrelated behavior.

## Scope
- Focus on unit tests only.
- Avoid integration/e2e style assertions unless explicitly requested.
- Prefer deterministic tests with clear assertions over broad smoke tests.

## Execution Protocol
1. Discover test setup:
- Read `package.json`.
- Read one Jest config file if present: `jest.config.js`, `jest.config.ts`, `jest.config.mjs`, or `jest.config.cjs`.
- Run `scan_project` and `list_untested_files`.
- If `package.json` already has `scripts.test`, keep using it. Do not replace or rewrite it.

2. Choose test file location:
- If the repo already has a top-level `tests/` folder, place new tests under `tests/` (same level as `src/`).
- If Jest `testMatch` contains `tests/**`, write tests under `tests/unit/` or existing `tests` structure.
- If Jest `testMatch` contains `__tests__`, place tests adjacent in `src/**/__tests__`.
- If both patterns exist, prefer the existing convention with the most current test files.
- Do not introduce a new convention if one already exists.

3. Generate and implement tests:
- Use `analyze_file` before writing tests.
- Use `generate_test_scaffold` only as a baseline, then replace placeholders with real assertions.
- Every written suite must include at least one real `it(...)` test case.
- Never keep scaffold placeholders in final tests (`TODO:`, `replace with precise assertion`, `supply constructor args if needed`).
- Do not write interface/type-shape tests (for example `import type ...` + `toHaveProperty` on object literals). Those are not runtime unit tests.
- In ESM Jest projects, import globals when needed:
  - `import { jest } from "@jest/globals";`
- If the target file contains no meaningful runtime behavior to unit-test (for example, only types/interfaces or empty declarations), do not open a PR with placeholder tests. Report explicitly that no meaningful unit test could be added.

4. Run tests with explicit path patterns:
- Never call `run_tests` with empty arguments in testing mode.
- Always pass `test_path_pattern` targeting the selected unit test path.
- Use concrete file/directory paths for `test_path_pattern`, not glob strings with `**`.
- Preferred patterns (in order):
  - `tests/unit`
  - `tests`
  - `src/__tests__`
  - `__tests__`

5. Stabilize failures:
- If tests fail due to imports from non-unit modules, mock those modules or narrow the test scope.
- If config mismatch causes "No tests found", update only the minimal `testMatch` needed.
- Do not replace working scripts/config wholesale.

6. Delivery after success:
- After `run_tests` passes, execute the git delivery workflow:
  - Run `./skills/git/delivery/verify.sh` via `run_command(path, args)`.
  - Read `skills/git/delivery/instructions.md`.
  - Create branch, commit, push, and open PR via `run_command(command, args)` with `git`/`gh`.

## File/Path Rules
- Use relative paths only.
- Keep tests close to source unless repository already centralizes tests.
- Do not write tests into build output directories (`dist`, `build`, `coverage`).

## Quality Bar
- Each new test should assert behavior, not only existence.
- Cover success path and at least one edge or error path for non-trivial logic.
- Avoid fragile time/random/network dependencies unless mocked.
- Placeholder-only tests are not acceptable for delivery.
