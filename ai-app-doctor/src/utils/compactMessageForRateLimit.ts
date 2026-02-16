export function compactMessagesForRateLimit(messages: any[]): any[] {
    if (messages.length <= 18) return messages;

    const firstSystem = messages.find((m) => m?.role === "system");
    const firstUser = messages.find((m) => m?.role === "user");
    const tail = messages.slice(-14);

    const compacted: any[] = [];
    const seen = new Set<any>();

    for (const candidate of [firstSystem, firstUser, ...tail]) {
        if (!candidate || seen.has(candidate)) continue;
        compacted.push(candidate);
        seen.add(candidate);
    }
    return compacted;
}