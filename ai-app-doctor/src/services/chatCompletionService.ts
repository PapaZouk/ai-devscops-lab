import type { OpenAI } from "openai";
import { compactMessagesForRateLimit } from "../utils/compactMessageForRateLimit.js";
import { extractRateLimitWaitMs } from "../utils/extractRateLimitWaitMs.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createChatCompletionWithRateLimit(params: {
  openai: OpenAI;
  model: string;
  messages: any[];
  tools: any[];
  maxRateLimitRetries: number;
  logger: {
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  warnColorize?: (msg: string) => string;
  errorColorize?: (msg: string) => string;
}): Promise<{
  response: any;
  messages: any[];
}> {
  const {
    openai,
    model,
    tools,
    maxRateLimitRetries,
    logger,
    warnColorize = (s) => s,
    errorColorize = (s) => s,
  } = params;
  let messages = params.messages;
  let rateLimitAttempts = 0;

  while (true) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
      });
      return { response, messages };
    } catch (err: any) {
      const status = Number(err?.status ?? 0);
      if (status !== 429) throw err;

      rateLimitAttempts += 1;
      if (rateLimitAttempts > maxRateLimitRetries) {
        logger.error(
          errorColorize(
            `❌ Rate limit retries exceeded (${maxRateLimitRetries}) for model ${model}.`
          )
        );
        throw err;
      }

      const waitMs = extractRateLimitWaitMs(err) + Math.floor(Math.random() * 250);
      logger.warn(
        warnColorize(
          `⚠️ LLM rate-limited (429) on ${model}. Retrying in ${(waitMs / 1000).toFixed(
            2
          )}s (attempt ${rateLimitAttempts}/${maxRateLimitRetries}).`
        )
      );
      messages = compactMessagesForRateLimit(messages);
      await sleep(waitMs);
    }
  }
}
