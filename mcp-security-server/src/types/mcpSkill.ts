export interface McpSkill {
    name: string;
    description: string;
    register: (server: any, projectRoot: string) => Promise<void>
}