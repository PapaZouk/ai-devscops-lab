import chalk from "chalk";
import OpenAI from "openai";
import { updateScratchpad } from "./helpers/updateScratchpad.js";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

export async function runReviewerAgent(
    filePath: string,
    proposedCode: string,
    originalCode: string,
    latestError: string,
    contract: any
): Promise<{ approved: boolean; feedback?: string }> {
    console.log(chalk.magenta(`  🔍 Auditor: Analyzing proposed changes for ${filePath}...`));

    const isTestFile = filePath.toLowerCase().includes('test') || filePath.toLowerCase().includes('spec');

    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages: [
            {
                role: 'system',
                content: `You are a Pragmatic DevSecOps Auditor. Your goal is to move remediation forward.

            ### AUDIT HIERARCHY (Priority Order):
            1. **FUNCTIONAL PARITY:** Does it break the public API? (Exports/Function Signatures). If YES -> REJECT.
            2. **CORE VULNERABILITY:** Is the hardcoded secret gone? Is hashing present? If YES -> PROCEED.
            3. **IMPORT VALIDATION:** Does the code call libraries it hasn't imported? If YES -> REJECT.
            4. **NITPICKS (Complexity, Claims, Logs):** Are these missing? If YES, but points 1-3 are solid -> **APPROVE with a "NUDGE" in the reason.**

            ### MIGRATION PHILOSOPHY:
            - **DO NOT** reject code for "missing regex complexity" if it successfully moves a secret to process.env. That is a net-positive move.
            - **DO NOT** reject if the database still has plain-text; we are fixing the CODE layer now.

            ### TECHNICAL CONSTRAINTS:
            - Must use ESM (imports). 
            - Must use '.js' extensions.
            - Must address the specific error: "${(latestError || "None").slice(0, 150)}"

            Format your response exactly:
            RESULT: [APPROVED or REJECTED]
            SEVERITY: [CRITICAL, MINOR, or NONE]
            REASON: [Technical explanation]`
            },
            {
                role: 'user',
                content: `CONTRACT: ${JSON.stringify(contract.required_changes)}
                PROPOSED CODE:
                ${proposedCode}`
            }
        ],
        temperature: 0.1 // Lower temp for more consistent auditing
    });

    const content = response.choices[0].message.content || "";
    // Robust detection: Look for "RESULT: APPROVED" even if model adds fluff
    const isApproved = /RESULT:\s*APPROVED/i.test(content);

    await updateScratchpad(`
## 🔍 AUDITOR REVIEW LOG [${new Date().toLocaleTimeString()}]
**Verdict:** ${isApproved ? '✅ APPROVED' : '❌ REJECTED'}
**Analysis:** ${content.replace('RESULT: APPROVED', '').replace('RESULT: REJECTED', '').trim()}
---`);

    return { approved: isApproved, feedback: content };
}