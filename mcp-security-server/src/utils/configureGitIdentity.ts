import { executeCommand } from "./executeCommand.js";
import { shellQuote } from "./shellQuote.js";

export async function configureGitIdentity(projectRoot: string) {
    const fallbackEmail = process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com";
    const fallbackName = process.env.GIT_AUTHOR_NAME || "github-actions[bot]";

    await executeCommand(projectRoot, `git config user.email ${shellQuote(fallbackEmail)}`);
    await executeCommand(projectRoot, `git config user.name ${shellQuote(fallbackName)}`);
}