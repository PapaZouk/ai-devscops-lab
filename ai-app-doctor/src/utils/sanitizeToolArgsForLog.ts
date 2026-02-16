import { truncateOutputText } from "./truncateOutputText.js";

export function sanitizeToolArgsForLog(rawArgs: string): string {
    try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object") {
            const shallow = { ...parsed };
            for (const key of ["content", "code"]) {
                if (typeof shallow[key] === "string") {
                    shallow[key] = truncateOutputText(shallow[key], 500);
                }
            }
            return JSON.stringify(shallow, null, 2);
        }
        return truncateOutputText(rawArgs, 500);
    } catch {
        return truncateOutputText(rawArgs, 500);
    }
}
