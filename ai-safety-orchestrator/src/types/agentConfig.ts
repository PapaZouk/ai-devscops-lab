export interface AgentConfig {
    name: string;
    model: string;
    systemPrompt: string;
    defaultUserPrompt: string;
    maxSteps?: number;
    allowedTools?: string[];
    generatePrompt?: (targetFile: string, issue: string) => string;
}