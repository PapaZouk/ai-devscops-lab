import z from "zod";
import { McpSkill } from "../../types/mcpSkill.js";
import { handleReadFile } from "../../tools/readFile.js";
import { handleListFiles } from "../../tools/listFiles.js";
import { getLogger } from "@logtape/logtape";

const FilesystemInputSchema = {
    read: z.object({
        path: z.string().describe("Relative path to the file to read")
    }),
    list: z.object({
        path: z.string().describe("Relative path to the directory (use '.' for root)"),
        recursive: z.boolean().optional().default(false)
    })
};

const logger = getLogger("filesystem");

export const FilesystemSkill: McpSkill = {
    name: "filesystem-management",
    description: "Tools for exploring and reading the project structure",
    register: async (server, projectRoot) => {
        server.registerTool(
            "read_file",
            {
                description: "Reads the content of a file for analysis.",
                inputSchema: FilesystemInputSchema.read
            },
            async (args: z.infer<typeof FilesystemInputSchema.read>) => {
                const result = await handleReadFile(projectRoot, args);

                if (result.isError) {
                    logger.error(`❌ Read file failed: ${result.content.map(item => item.text).join("\n")}`);
                } else {
                    logger.info(`✅ Read file successful: ${args.path}`);
                }

                return {
                    content: result.content.map(item => ({ ...item, type: "text" as const })),
                    isError: result.isError
                };
            }
        );

        server.registerTool(
            "list_files",
            {
                description: "Lists files and directories to help explore the project.",
                inputSchema: FilesystemInputSchema.list
            },
            async (args: z.infer<typeof FilesystemInputSchema.list>) => {
                const result = await handleListFiles(projectRoot, args);

                if (result.content.length === 0) {
                    logger.error(`❌ List files failed: ${result.content.map(item => item.json).join("\n")}`);
                } else {
                    logger.info(`✅ List files successful: ${args.path} (found ${JSON.parse(result.content[0].json).length} entries)`);
                }

                return {
                    content: [{ type: "text" as const, text: JSON.stringify(result.content, null, 2) }],
                    isError: false
                };
            }
        );
    }
}