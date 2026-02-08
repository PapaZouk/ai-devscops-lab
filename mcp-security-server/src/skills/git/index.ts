import { z } from "zod";
import { McpSkill } from "../../types/mcpSkill.js";
import { simpleGit, SimpleGit } from "simple-git";
import db from "../../utils/db.js";
import chalk from "chalk";
import { getLogger } from "@logtape/logtape";

const GitInputSchema = {
    action: z.enum(["status", "branch", "commit", "push"]),
    branchName: z.string().optional().describe("Required for 'branch' action"),
    message: z.string().optional().describe("Required for 'commit' action"),
};

const logger = getLogger("gitManagement");

export const GitSkill: McpSkill = {
    name: "git-management",
    description: "Advanced Git operations for automated remediation",
    register: async (server, projectRoot) => {
        const git: SimpleGit = simpleGit(projectRoot);

        server.registerTool(
            "git_manager",
            {
                description: "Performs Git operations like branch, commit, and push.",
                inputSchema: GitInputSchema
            },
            async (args: z.infer<z.ZodObject<typeof GitInputSchema>>) => {
                let status = "SUCCESS";
                let output = "";

                try {
                    switch (args.action) {
                        case "status":
                            const statusRes = await git.status();
                            output = JSON.stringify(statusRes, null, 2);
                            break;

                        case "branch":
                            if (!args.branchName) throw new Error("branchName is required");
                            await git.checkoutLocalBranch(args.branchName);
                            output = `Created and checked out branch: ${args.branchName}`;
                            break;

                        case "commit":
                            if (!args.message) throw new Error("message is required");
                            await git.add(".");
                            const commitRes = await git.commit(args.message);
                            output = `Committed changes: ${commitRes.commit}`;
                            break;

                        case "push":
                            const currentBranch = (await git.status()).current;
                            if (!currentBranch) throw new Error("Could not determine current branch.");
                            await git.push("origin", currentBranch);
                            output = `Pushed ${currentBranch} to origin`;
                            break;
                    }

                    db.prepare(`
                        INSERT INTO audit_logs (file_path, action, status, biome_output) 
                        VALUES (?, ?, ?, ?)
                    `).run("GIT_REPO", `GIT_${args.action.toUpperCase()}`, "SUCCESS", output);

                    logger.info(chalk.green(`✅ Git ${args.action} completed.`));
                    return { content: [{ type: "text", text: output }] };

                } catch (error: any) {
                    status = "ERROR";
                    output = error.message;

                    // Log the failure
                    db.prepare(`
                        INSERT INTO audit_logs (file_path, action, status, biome_output) 
                        VALUES (?, ?, ?, ?)
                    `).run("GIT_REPO", `GIT_${args.action.toUpperCase()}`, "FAILURE", output);

                    logger.error(chalk.red(`❌ Git ${args.action} failed: ${output}`));
                    return {
                        content: [{ type: "text", text: `Error: ${output}` }],
                        isError: true
                    };
                }
            }
        );
    }
};