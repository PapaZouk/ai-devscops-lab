export function isDeliveryRunCommandCall(toolName: string, rawArgs: string): boolean {
    if (toolName !== "run_command") return false;

    try {
        const parsed = JSON.parse(rawArgs || "{}") as { command?: string; path?: string };
        const command = (parsed.command || "").trim();
        const scriptPath = (parsed.path || "").trim();

        if (command === "git" || command === "gh") return true;
        if (scriptPath.includes("skills/git/delivery")) return true;
    } catch {
        return true;
    }
    return false;
}
