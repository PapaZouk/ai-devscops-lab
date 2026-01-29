import { format } from "node:path";
import { FixPlanSchema, type FixPlan } from "../types/RemediationSchema";
import z from "../../node_modules/zod/index.cjs";
import { OpenAI } from "../../node_modules/openai/client";
import { configDotenv } from "../../node_modules/dotenv/lib/main";

configDotenv();

export class AIEngine {
    private openai: OpenAI;
    private model: string;

    constructor() {
        this.openai = new OpenAI({
            baseURL: process.env.AI_BASE_URL || 'http://localhost:11434/v1',
            apiKey: process.env.AI_API_KEY || 'ollama'
        });
        this.model = process.env.AI_MODEL || 'llama3.2';
    }
    

    public async suggestFix(vulnerabilities: any[]): Promise<FixPlan | null> {

        console.log("Sending vulnerabilities to AI engine for fix suggestions...");
        console.log(`Start time: ${new Date().toISOString()}`);

        const prompt = `You are DevSecOps AI assistant. Given the following vulnerabilities, suggest code fixes or mitigation steps for each one in a concise manner.
        
        Provide a fix plan in JSON for these vulnerabilities: ${JSON.stringify(vulnerabilities, null, 2)}.
        Strictly follow the schema provided:
        {
            "summary": "A brief summary of the fix plan",
            "actions": [
                {
                    "package": "name of the package to fix",
                    "command": "the npm command to run to fix it, e.g., npm install package@version",
                    "reason": "a brief reason for this action"
                }
            ],
            "risk_level": "overall risk level: low, medium, high, or critical"
        }`;

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: 'system', content: 'You are a helpful DevSecOps assistant.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1000,
                temperature: 0.2,
                response_format: { type: 'json_object' }
            });

            const content = response.choices[0]?.message?.content;

            if (!content) {
                console.error("AI engine returned empty content.");
                return null;
            }

            const rawJson = JSON.parse(content as string);

            const validatedPlan = FixPlanSchema.parse(rawJson);
            console.log(`Fix plan received and validated successfully.`);
            console.log(`End time: ${new Date().toISOString()}`);
            return validatedPlan;
        } catch (error) {
            if (error instanceof z.ZodError) {
                console.error("Validation error in AI response:", error.message);
            } else {
                console.error("Error communicating with AI engine:", error);
            }
            return null;
        }
    }

    public async generatePRDescription(vulnerabilities: any[]): Promise<{ title: string, body: string }> {
        const summary = vulnerabilities.map(v => `- Fixed ${v.id} in ${v.packageName}`).join('\n');
        const prompt = `Generate a GitHub Pull Request title and a professional description for these security fixes:\n${summary}`;
        
        const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
            { role: 'system', content: 'You are a professional assistant that generates GitHub PR titles and descriptions.' },
            { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.3,
        });
            
        const prContent = response.choices[0]?.message?.content;
        
        return {
            title: "security: fix multiple vulnerabilities identified by Snyk",
            body: prContent || `This PR addresses the following vulnerabilities:\n${summary}`
        };
    }
}