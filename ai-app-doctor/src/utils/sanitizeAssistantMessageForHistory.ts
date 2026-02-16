import { truncateOutputText } from "./truncateOutputText.js";

export function sanitizeAssistantMessageForHistory(message: any, maxHistoryToolArgs: number) {
    if (!message?.tool_calls?.length) return message;

    return {
        ...message,
        tool_calls: message.tool_calls.map((call: any) => ({
            ...call,
            function: {
                ...call.function,
                arguments: truncateOutputText(call.function?.arguments || "{}", maxHistoryToolArgs)
            }
        }))
    };
}
