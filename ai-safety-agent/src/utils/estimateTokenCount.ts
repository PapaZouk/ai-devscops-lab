import OpenAI from "openai";

export function estimateTokenCount(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
    return messages.reduce((acc, msg) => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) || '';
        return acc + (content.length / 4) + 20;
    }, 0);
}