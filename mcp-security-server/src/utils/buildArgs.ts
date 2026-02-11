import { shellQuote } from "./shellQuote.js";

export function buildArgs(args?: string[]): string {
    return args ? args.map(shellQuote).join(" ") : "";
}