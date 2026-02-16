export function deriveRunTestsFailureFingerprint(stderr: string): string {
  const s = (stderr || "").toLowerCase();
  if (!s.trim()) return "unknown";

  const knownPatterns = [
    "could not locate module",
    "does not provide an export named",
    "expect(received).toequal(expected)",
    "expect(received).tohavelength(expected)",
    "testsuite failed to run",
  ];
  for (const pattern of knownPatterns) {
    if (s.includes(pattern)) return pattern;
  }

  const match = s.match(/●\s+([^\n]+)/);
  if (match?.[1]) return `jest:${match[1].trim()}`;

  return (
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ") || "unknown"
  );
}

