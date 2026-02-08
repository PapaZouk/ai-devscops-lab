import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitSkill } from "../skills/git/index.js";
import { SecuritySkill } from "../skills/security/index.js";
import { FilesystemSkill } from "../skills/filesystem/index.js";

const enabledSkills = [
    FilesystemSkill,
    GitSkill,
    SecuritySkill
];

export default async function registerTools(server: McpServer, projectRoot: string) {
    for (const skill of enabledSkills) {
        await skill.register(server, projectRoot);
    }
}