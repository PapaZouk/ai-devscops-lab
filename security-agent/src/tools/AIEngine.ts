import { FixPlanSchema, type FixPlan } from "../types/RemediationSchema";
import { OpenAI } from "openai";
import { configDotenv } from "dotenv";

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
        console.log("Processing vulnerabilities for AI...");

        const thinnedData = vulnerabilities
            .filter(v => v.severity === 'high' || v.severity === 'critical')
            .map(v => ({
                id: v.id,
                package: v.packageName,
                currentVersion: v.version,
                fixAvailableIn: v.fixedIn
            }));

        if (thinnedData.length === 0) {
            console.log("No high or critical vulnerabilities to process.");
            return null;
        }

        console.log(`Sending ${thinnedData.length} issues to AI (${this.model})...`);
        console.log(`Start time: ${new Date().toISOString()}`);

        const prompt = `You are a DevSecOps AI assistant. 
        Target Project Folder: victim-app

        Vulnerabilities to fix: ${JSON.stringify(thinnedData, null, 2)}

        TASK:
        1. Identify the best version to upgrade to for each package based on "fixAvailableIn".
        2. Combine these into a BATCH update command if possible to save time.
        3. Provide the response strictly in JSON.

        JSON SCHEMA:
        {
            "summary": "Clear summary of versions being upgraded",
            "actions": [
                {
                    "package": "name(s) of the packages",
                    "command": "npm install pkg1@ver1 pkg2@ver2 --save",
                    "reason": "Fixes CVE-XXX, CVE-YYY"
                }
            ],
            "risk_level": "low|medium|high|critical"
        }`;

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: 'system', content: 'You are a DevSecOps expert that provides batch remediation commands.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1000,
                temperature: 0.1, // Lower temperature for more consistent JSON
                response_format: { type: 'json_object' }
            });

            const content = response.choices[0]?.message?.content;
            if (!content) return null;

            const validatedPlan = FixPlanSchema.parse(JSON.parse(content));
            console.log(`Batch fix plan received. Risk Level: ${validatedPlan.risk_level}`);
            console.log(`End time: ${new Date().toISOString()}`);
            
            return validatedPlan;
        } catch (error) {
            console.error("AI processing failed:", error);
            return null;
        }
    }

    public async generatePRDescription(vulnerabilities: any[]): Promise<{ title: string, body: string }> {
        // Use thinned data here too for a faster, cleaner PR body
        const summaryList = vulnerabilities
            .filter(v => v.severity === 'high' || v.severity === 'critical')
            .map(v => `- **${v.packageName}**: Fixed ${v.id} (${v.title})`)
            .join('\n');

        const prompt = `Create a professional GitHub PR description for these security fixes:\n${summaryList}`;
        
        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: 'system', content: 'You generate professional GitHub PR descriptions.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 500,
            });

            return {
                title: `security: fix ${vulnerabilities.length} high/critical vulnerabilities`,
                body: response.choices[0]?.message?.content || `Automated security fixes:\n${summaryList}`
            };
        } catch (e) {
            return {
                title: "security: automated vulnerability remediation",
                body: `This PR addresses high-risk vulnerabilities:\n${summaryList}`
            };
        }
    }
}