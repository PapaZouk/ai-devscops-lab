import type { AgentConfig } from "../../types/agentConfig.js";
import { getRuntimeInstructions } from "./promptTemplates.js";

export const getSystemPrompt = (config: AgentConfig, runtimeConfig: any) => {
    const runtimeInstructions =
        config.runtimeInstructionsOverride ?? getRuntimeInstructions({ skipDelivery: runtimeConfig.shouldSkipDelivery });

    return `
        ${config.systemPrompt}

        # RUNTIME CONTEXT
        - **Workbench**: Current Directory (.) is the project root.
        - **Tools**: Access to skills library via './skills'.

        ${runtimeInstructions}

        # SAFETY CONSTRAINTS
        - NEVER use absolute paths.
        - DO NOT remove existing logs.
        - If a fix fails 3 times, provide a diagnosis and STOP.
        `.trim();
};
