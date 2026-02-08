export interface AgentConfig {
    name: string;
    model: string;
    systemPrompt: string;
    defaultUserPrompt: string;
    maxSteps?: number;
    generatePrompt?: (targetFile: string, issue: string) => string;
}