import chalk from "chalk";
import OpenAI from "openai";
import { updateScratchpad } from "./helpers/updateScratchpad.js";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

export async function runDefinition(filePath: string, code: string, errorLog: string) {
    console.log(chalk.blue(`  📋 Definition Agent: Defining the problem for ${filePath}...`));

    const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: 'system',
        content: `You are a Technical Lead. Analyze the code and error. 
        Output a strict JSON "Remediation Contract". 
        CRITICAL: Your response must be ONLY the JSON object. No preamble, no markdown blocks, no trailing commas in arrays.
        
        {
          "vulnerability_analysis": "string",
          "required_changes": ["string[]"],
          "functional_invariants": ["string[]"],
          "security_standard": "string",
          "verification_steps": ["string[]"]
        }`
    };

    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages: [
            systemPrompt,
            { role: 'user', content: `FILE PATH: ${filePath}\n\nCODE: ${code}\n\nERROR: ${errorLog}` }
        ],
        max_completion_tokens: 4024,
        temperature: 0.2,
    });

    const rawContent = response.choices[0].message.content || '{}';

    try {
        const firstBrace = rawContent.indexOf('{');
        const lastBrace = rawContent.lastIndexOf('}');

        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");

        let jsonString = rawContent.substring(firstBrace, lastBrace + 1);

        // Strip markdown blocks and handle trailing commas inside arrays/objects
        jsonString = jsonString
            .replace(/^```json\n|```$/gm, '')
            .replace(/,\s*([\]}])/g, '$1')
            .trim();

        const contract = JSON.parse(jsonString);
        await updateScratchpad(`CONTRACT DEFINED: ${contract.vulnerability_analysis.slice(0, 50)}...`);
        return contract;
    } catch (parseError) {
        console.error(chalk.red(`  🚨 JSON Parse Error at ${filePath}. Raw output was logged to scratchpad.`));
        await updateScratchpad(`CRITICAL_PARSE_ERROR: ${rawContent}`);

        return {
            vulnerability_analysis: "Failed to parse contract logic.",
            required_changes: ["Manual review required due to LLM syntax error"],
            functional_invariants: ["Check original file exports"],
            security_standard: "Generic Security Best Practices",
            verification_steps: ["Verify via standard test suite"]
        };
    }
}