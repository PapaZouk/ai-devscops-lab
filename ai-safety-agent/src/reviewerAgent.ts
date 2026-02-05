import chalk from "chalk";
import OpenAI from "openai";
import { updateScratchpad } from "./helpers/updateScratchpad.js";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

/**
 * Orchestrates the Auditor's review of a proposed code change.
 * Uses generalized principles to ensure security compliance and functional parity.
 */
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
                content: `You are a Senior DevSecOps Auditor reviewing code changes against a technical remediation contract.

            CURRENT FILE: ${filePath}
            FILE CONTEXT: ${isTestFile ? 'TEST SUITE (Verification Logic)' : 'SOURCE CODE (Implementation Logic)'}

            GENERAL AUDIT PRINCIPLES:
            1. MIGRATION TOLERANCE: Security upgrades often create temporary mismatches between files (e.g., Service expects hashed data, but DB still provides plain text). DO NOT reject a file for this inconsistency; approve if the logic in THIS specific file is correct according to the contract.
            2. SCOPE RESPONSIBILITY: Only reject a file if the vulnerabilities SPECIFIC to its role remain unaddressed. For example, do not reject a database-only update because it doesn't fix logic in the service layer.
            3. ATOMICITY: Do not reject architectural improvements merely because dependencies in other modules are still in their original, unpatched state. Assume sequential patching will occur.

            ${!isTestFile ? `
            SOURCE CODE AUDIT RULES:
            1. SECURITY COMPLIANCE: Verify that the changes eliminate the vulnerabilities defined in the contract for this specific module.
            2. CONFIGURATION RIGOR: Ensure that external dependencies and environment requirements are strictly enforced (e.g., throwing errors if required configurations are missing).
            3. INTERFACE PARITY: Maintain all original external exports and core business logic flows unless the contract explicitly mandates their modification.
            4. INVARIANTS: Adhere strictly to the following constraints: ${JSON.stringify(contract.functional_invariants || {}, null, 2)}
            ` : `
            TEST SUITE AUDIT RULES:
            1. TEST CONTEXT: In test files, allow the explicit definition of environment variables and mock data necessary to satisfy the new implementation requirements.
            2. TEST INTEGRITY: Ensure the suite is updated to reflect new logic while maintaining or improving original coverage levels.
            3. NO DELETIONS: Tests must be modified to pass under the new technical constraints, not removed.
            `}

            TECHNICAL STANDARDS:
            - MODULE SYSTEM: Strictly enforce ESM (import/export) syntax.
            - PATH RESOLUTION: All local module references must include the '.js' extension.
            - ERROR RESOLUTION: Evaluate if the proposal addresses the following system output: "${(latestError || "No current error").slice(0, 200)}".

            Format your response EXACTLY as:
            RESULT: [APPROVED or REJECTED]
            REASON: [Clear technical explanation]`
            },
            {
                role: 'user',
                content: `REMEDIATION CONTRACT: ${JSON.stringify(contract.required_changes)}\n\nORIGINAL CODE:\n${originalCode}\n\nPROPOSED CODE:\n${proposedCode}`
            }
        ]
    });

    const content = response.choices[0].message.content || "";
    const isApproved = content.includes("RESULT: APPROVED");

    await updateScratchpad(`
## 🔍 AUDITOR REVIEW LOG [${new Date().toLocaleTimeString()}]
**File:** ${filePath}
**Verdict:** ${isApproved ? '✅ APPROVED' : '❌ REJECTED'}
**Full Audit Reasoning:**
${content}
---`);

    const reasonLine = content.split('\n').find(l => l.startsWith('REASON:')) || 'No reason provided.';
    console.log(chalk.magentaBright(`     Auditor Feedback: ${reasonLine}`));

    return {
        approved: isApproved,
        feedback: content
    };
}