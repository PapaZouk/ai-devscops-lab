export interface AgentConfig {
    name: string;
    model: string;
    systemPrompt: string;
    defaultUserPrompt: string;
    mcpServerPath?: string;
    projectRootMode?: "cwd" | "target";
    runtimeInstructionsOverride?: string;
    maxSteps?: number;
    generatePrompt?: (targetFile: string, issue: string) => string;
}
