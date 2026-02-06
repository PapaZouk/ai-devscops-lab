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
        CRITICAL: Your response must be ONLY the JSON object. No conversation. No markdown blocks.
        
        {
          "vulnerability_analysis": "string",
          "required_changes": ["string"],
          "functional_invariants": ["string"],
          "security_standard": "string",
          "verification_steps": ["string"]
        }`
    };

    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages: [
            systemPrompt,
            { role: 'user', content: `FILE PATH: ${filePath}\n\nCODE: ${code}\n\nERROR: ${errorLog}` }
        ],
        max_completion_tokens: 4024,
        temperature: 0.1,
    });

    const rawContent = response.choices[0].message.content || '{}';

    try {
        const firstBrace = rawContent.indexOf('{');
        const lastBrace = rawContent.lastIndexOf('}');

        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found");

        let jsonString = rawContent.substring(firstBrace, lastBrace + 1);

        // Robust cleaning for LLM formatting idiosyncrasies
        jsonString = jsonString
            .replace(/\n/g, ' ')             // Prevent line-break parsing errors
            .replace(/\r/g, ' ')
            .replace(/\t/g, ' ')
            .replace(/,\s*([\]}])/g, '$1')   // Remove trailing commas
            .replace(/\s+/g, ' ')            // Normalize whitespace
            .trim();

        const contract = JSON.parse(jsonString);

        await updateScratchpad(`CONTRACT DEFINED: ${contract.vulnerability_analysis.slice(0, 100)}`);
        return contract;

    } catch (parseError) {
        console.error(chalk.red(`  🚨 JSON Parse Error at ${filePath}. Falling back to emergency contract.`));
        await updateScratchpad(`CRITICAL_PARSE_ERROR: ${rawContent}`);

        // Safe fallback to prevent the Orchestrator from operating "blind"
        return {
            vulnerability_analysis: "Insecure JWT implementation and hardcoded secrets.",
            required_changes: [
                "Remove all hardcoded secrets and fallback strings",
                "Implement environment variable enforcement for AUTH_SECRET",
                "Use bcrypt for password hashing and comparison"
            ],
            functional_invariants: [
                "Maintain original login(username, password) signature",
                "Maintain original verifyToken(token) signature"
            ],
            security_standard: "OWASP Top 10: Broken Access Control",
            verification_steps: ["Run integration tests", "Verify environment variable validation"]
        };
    }
}