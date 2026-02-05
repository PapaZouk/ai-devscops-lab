import chalk from "chalk";
import OpenAI from "openai";
import { updateScratchpad } from "./helpers/updateScratchpad.js";
import path from "path"; // Fix: Use standard path, not win32 specific

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

export async function runReviewerAgent(
    filePath: string,
    proposedCode: string,
    originalCode: string,
    evidence: string,
    contract: any // Add this to allow the auditor to check against invariants
): Promise<{ approved: boolean; feedback?: string }> {
    console.log(chalk.magenta(`  🔍 Auditor: Analyzing proposed changes for ${filePath}...`));

    // Determine if we are auditing a test file or a source file
    const isTestFile = filePath.includes('test') || filePath.includes('spec');

    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages: [
            {
                role: 'system',
                content: `You are a Senior DevSecOps Auditor. 
                
                CURRENT FILE BEING AUDITED: ${filePath}
                FILE TYPE: ${isTestFile ? 'TEST SUITE' : 'SOURCE CODE'}

                ${!isTestFile ? `
                STRICT SOURCE CODE RULES:
                1. SECURITY: Must be more secure (e.g., no hardcoded secrets).
                2. PARITY: Must maintain all original exports and core business logic.
                3. CONTRACT INVARIANTS: 
                   ${JSON.stringify(contract.functional_invariants, null, 2)}
                ` : `
                TEST SUITE RULES:
                1. VALIDATION: Ensure the test now correctly supports the security changes (e.g., providing required ENV variables).
                2. COVERAGE: Do not allow tests to be deleted; they must be updated to pass with the new secure implementation.
                `}

                CRITERIA FOR ALL FILES:
                - STANDARDS: Use ESM imports with '.js' extensions.
                - NO FALLBACKS: Hard errors for missing environment variables.

                Format your response EXACTLY as:
                RESULT: [APPROVED or REJECTED]
                REASON: [Technical explanation]`
            },
            {
                role: 'user',
                content: `EVIDENCE (Context/Errors):\n${evidence}\n\nORIGINAL CODE:\n${originalCode}\n\nPROPOSED CODE:\n${proposedCode}`
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
        ---
    `);

    console.log(chalk.magentaBright(`     Auditor Feedback: ${content.split('\n').find(l => l.startsWith('REASON:')) || 'No reason provided.'}`));

    return {
        approved: isApproved,
        feedback: content
    };
}