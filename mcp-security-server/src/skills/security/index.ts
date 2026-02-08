import { z } from "zod";
import { McpSkill } from "../../types/mcpSkill.js";
import { handleSecureWrite } from "../../tools/secureWrite.js";
import db from "../../utils/db.js";

const SecurityInputSchema = {
    secure_write: z.object({
        path: z.string().describe("Relative path to the file"),
        code: z.string().describe("The full file content to write"),
    }),
    get_audit_logs: z.object({
        limit: z.number().optional().default(5)
    })
};

export const SecuritySkill: McpSkill = {
    name: "security-remediation",
    description: "Tools for safe code modification and audit tracking",
    register: async (server, projectRoot) => {

        server.registerTool(
            "secure_write",
            {
                description: "Writes code to a file and verifies it with Biome linting.",
                inputSchema: SecurityInputSchema.secure_write
            },
            async (args: z.infer<typeof SecurityInputSchema.secure_write>) => {
                return await handleSecureWrite(projectRoot, args);
            }
        );

        server.registerTool(
            "get_audit_logs",
            {
                description: "Retrieves the history of security fixes.",
                inputSchema: SecurityInputSchema.get_audit_logs
            },
            async (args: z.infer<typeof SecurityInputSchema.get_audit_logs>) => {
                const logs = db.prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?")
                    .all(args.limit);
                return {
                    content: [{ type: "text", text: JSON.stringify(logs, null, 2) }]
                };
            }
        );
    }
};