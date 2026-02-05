import OpenAI from "openai";
import { updateScratchpad } from "./helpers/updateScratchpad.js";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

export async function runTestingAgent(
    filePath: string,
    proposedCode: string,
    contract: any,
    latestError: string,
    apiMap: string
): Promise<string> {
    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages: [
            {
                role: 'system',
                content: `You are a Senior QA Engineer. 

                ### MODULE CONTEXT:
                ${apiMap}

                ### OPERATIONAL CONSTRAINTS:
                1. GROUND TRUTH: Use the "tests" path provided in the MODULE CONTEXT as your absolute destination.
                2. PATH MATH: Calculate relative imports by comparing the "tests" path to the "logic" and "data" paths. (e.g., if test is in 'tests/integration/' and logic is in 'src/services/', use '../../src/services/').
                3. ERROR RESOLUTION: If 'latestError' is provided, prioritize fixing that specific failure.
                4. IMPLEMENTATION ALIGNMENT: Validate the exports and logic found in the provided IMPLEMENTATION CODE.
                5. NO HALLUCINATIONS: Do not import files not listed in the MODULE CONTEXT. Mock missing dependencies.

                ### TECHNICAL STANDARDS:
                - Use ESM syntax with explicit .js extensions for all local imports.
                - Set environment variables (e.g., JWT_SECRET) within the test file.
                - Output raw code only. No markdown formatting.`
            },
            {
                role: 'user',
                content: `CONTRACT: ${JSON.stringify(contract)}
                LATEST ERROR: ${latestError || "None"}
                TARGET PATH: ${filePath}
                IMPLEMENTATION CODE:
                ${proposedCode}`
            }
        ]
    });

    let testCode = response.choices[0].message.content || "";

    // Safety: Ensure no accidental markdown wrapper leaks into the final file
    testCode = testCode.replace(/^```[a-z]*\n|```$/gm, '');

    await updateScratchpad(`## 🧪 TESTING AGENT LOG: Processing ${filePath}`);

    return testCode;
}