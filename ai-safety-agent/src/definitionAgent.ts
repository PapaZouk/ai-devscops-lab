import chalk from "chalk";
import OpenAI from "openai";

const client = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
});

export async function runDefinition(filePath: string, code: string, errorLog: string) {
    console.log(chalk.blue(`📋 Definition Agent: Defining the problem for ${filePath}...`));

    const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: 'system',
        content: `You are a Technical Lead. Analyze the code and error. 
        Output a strict JSON "Remediation Contract". 
        
        {
          "vulnerability_analysis": "Concise description of the flaw",
          "required_changes": ["list", "of", "atomic", "tasks"],
          "functional_invariants": ["What functions/exports must remain unchanged"],
          "security_standard": "The specific pattern to implement (e.g., 'Environment-based Secret Management')",
          "verification_steps": ["How the auditor should verify the fix"]
        }`
    };

    const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'google/gemma-3-4b',
        messages: [
            systemPrompt,
            {
                role: 'user',
                content: `FILE PATH:\n${filePath}\n\nCODE:\n${code}\n\nERROR LOG:\n${errorLog}`
            }
        ]
    });

    return JSON.parse(response.choices[0].message.content || '{}');
}