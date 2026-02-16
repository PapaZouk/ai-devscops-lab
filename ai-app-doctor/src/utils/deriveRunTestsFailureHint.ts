export function deriveRunTestsFailureHint(stderr: string): string | null {
    const s = (stderr || "").toLowerCase();
    if (!s) return null;

    if (
        s.includes("could not locate module") &&
        s.includes("mapped as:") &&
        s.includes("moduleNameMapper".toLowerCase())
    ) {
        return "Jest module mapping error detected. Fix mock/import path to the real target module path from the test file (for example in tests/, use ../../src/... instead of ../...).";
    }

    if (s.includes("does not provide an export named")) {
        return "Jest ESM import error detected. If importing a TypeScript interface/type, use `import type { ... }` and keep runtime imports separate.";
    }

    if (s.includes("received length") && s.includes("expected length")) {
        return "State leakage detected across tests. Reset shared mutable module state in beforeEach (for example arrays/objects in singleton db modules).";
    }

    if (s.includes("expected") && s.includes("received")) {
        return "Assertion mismatch detected. Update expected values to match real behavior from source code, not assumed IDs/counts.";
    }

    return null;
}