/*
* Extracts the wait time in milliseconds from an error object, based on HTTP headers or error message content.
* It's designed to handle rate limit errors from the LLM API, which may include headers like "Retry-After" 
* or error messages indicating how long to wait before retrying.
*/
export function extractRateLimitWaitMs(err: any): number {
    const headers = (err?.headers ?? {}) as Record<string, string | string[] | undefined>;
    const retryAfterRaw =
        headers["retry-after"] ??
        headers["Retry-After"] ??
        headers["x-ratelimit-reset-requests"] ??
        headers["x-ratelimit-reset-tokens"];

    const retryAfterStr = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;

    if (retryAfterStr) {
        const sec = Number(retryAfterStr);
        if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
    }

    const msg = String(err?.message ?? "");
    const waitMatch = msg.match(/try again in\s*([\d.]+)\s*s/i);
    if (waitMatch?.[1]) {
        const sec = Number(waitMatch[1]);
        if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
    }

    return 6000;
}