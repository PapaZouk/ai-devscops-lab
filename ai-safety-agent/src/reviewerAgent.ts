import chalk from "chalk";
import OpenAI from "openai";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});


export async function runReviewerAgent(
    filePath: string,
    proposedCode: string,
    originalCode: string,
    evidence: string
): Promise<{ approved: boolean; feedback?: string }> {
    console.log(chalk.magenta(`  🔍 Auditor: Analyzing proposed changes for ${filePath}...`));

    const response = await client.chat.completions.create({
        model: 'google/gemma-3-4b',
        messages: [
            {
                role: 'system',
                content: `You are a Senior DevSecOps Auditor. Your goal is to ensure security improvements do not break system functionality.

            CRITERIA FOR APPROVAL (Must pass all):
            1. SECURITY DELTA: The PROPOSED code must be objectively more secure than the ORIGINAL (e.g., replacing hardcoded strings with environment variables is a SUCCESS).
            2. FUNCTIONAL PARITY: All public exports, functions, and core business logic from the ORIGINAL must exist in the PROPOSED code. Do not accept partial snippets.
            3. MODULE STANDARDS: Must use ESM 'import/export'. No 'require'.
            4. STABILITY: Environment variables must be checked for existence before use (e.g., throwing a clear error if a variable is missing).

            CRITERIA FOR REJECTION:
            - If the agent "hallucinates" new dependencies not found in the original imports.
            - If the agent simplifies the logic so much that it loses original features.
            - If the agent introduces hardcoded fallback values (e.g., const secret = process.env.KEY || 'default').

            Format your response as:
            RESULT: [APPROVED/REJECTED]
            REASON: [Technical explanation of the delta]`
            },
            {
                role: 'user',
                content: `EVIDENCE (Test Failures):\n${evidence}\n\nORIGINAL CODE:\n${originalCode}\n\nPROPOSED CODE:\n${proposedCode}`
            }
        ]
    });

    const content = response.choices[0].message.content || "";
    const isApproved = content.includes("RESULT: APPROVED");

    console.log(chalk.magentaBright(`     Auditor Feedback: ${content.split('\n')[1] || content}`));

    return {
        approved: isApproved,
        feedback: content
    };
}