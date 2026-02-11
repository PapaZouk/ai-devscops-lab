export function joinOutput(...outputs: Array<string | undefined>): string {
    return outputs.filter(Boolean).join("\n").trim() || "Done (no output).";
}