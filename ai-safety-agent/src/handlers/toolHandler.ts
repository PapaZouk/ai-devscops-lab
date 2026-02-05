import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { getKnowledgeBase } from '../tools/getKnowledgeBase.js';
import { runReviewerAgent } from '../reviewerAgent.js';
import { updateScratchpad } from '../helpers/updateScratchpad.js';

interface ToolContext {
    apiRoot: string;
    agentRoot: string;
    initialCode: string;
    latestError: string;
    contract: any;
    messages: any[];
}

export async function handleToolCall(name: string, args: any, context: ToolContext) {
    const { apiRoot, agentRoot, initialCode, contract, messages } = context;
    let result = "";
    // Initialize with existing error so we don't lose context
    let latestError = context.latestError;

    const rawPath = args.path || "";
    const isInternal = rawPath.startsWith('.agent_memory');
    const fullPath = isInternal ? path.resolve(agentRoot, rawPath) : path.resolve(apiRoot, rawPath);

    switch (name) {
        case 'get_knowledge':
            result = await getKnowledgeBase(args.query || args.path || "security");
            console.log(chalk.cyan(`     ✅ Knowledge retrieved.`));
            break;

        case 'api_directory_helper':
            const mapPath = path.resolve(agentRoot, 'agent_knowledge/api_map.json');
            const mapData = JSON.parse(await fs.readFile(mapPath, 'utf8'));
            const moduleKey = Object.keys(mapData).find(k => k.toLowerCase().includes(args.moduleName?.toLowerCase() || ""));
            result = JSON.stringify(moduleKey ? mapData[moduleKey] : "Module not found.", null, 2);
            console.log(moduleKey ? chalk.green(`     ✅ Context mapped.`) : chalk.red(`     ❌ Module missing.`));
            break;

        case 'read_file':
            try {
                const stats = await fs.stat(fullPath);
                result = stats.isDirectory()
                    ? `ERROR: '${args.path}' is a directory. Provide a file path.`
                    : await fs.readFile(fullPath, 'utf-8');
                console.log(chalk.green(`     ✅ Read ${args.path}`));
            } catch (e: any) {
                result = `ERROR: Could not read file at ${args.path}.`;
            }
            break;

        case 'propose_fix':
            console.log(chalk.blue(`     🔍 Reviewer Agent: Auditing proposed fix...`));
            // CRITICAL: We pass latestError here so the Auditor knows why the previous write failed
            const audit = await runReviewerAgent(args.path, args.code, initialCode, latestError, contract);
            result = audit.approved ? "APPROVED" : `REJECTED: ${audit.feedback}`;

            if (audit.approved) {
                console.log(chalk.green.bold(`     ✅ Auditor: Approved.`));
            } else {
                console.log(chalk.red.bold(`     ❌ Auditor: Rejected.`));
            }
            break;

        case 'write_fix':
            // Check for approval in recent messages
            const wasApproved = messages.some(m => m.role === 'tool' && m.content === 'APPROVED');

            if (!wasApproved) {
                result = "REJECTED: You must call 'propose_fix' and receive an 'APPROVED' response before 'write_fix'.";
                console.log(chalk.yellow.bold(`     ⚠️ Safety: Blocked write attempt without approval.`));
            } else {
                await fs.writeFile(fullPath, args.code, 'utf8');
                console.log(chalk.yellow(`     💾 Changes saved. Validating...`));
                try {
                    // Try to fix linting errors automatically first
                    try {
                        execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
                    } catch (lintErr) { /* non-fatal lint errors */ }

                    // Run the test suite
                    execSync('npm test', { cwd: apiRoot, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test' } });

                    console.log(chalk.green.bold(`     ✅ SUCCESS: Tests passed.`));
                    // Reset error on success
                    latestError = "";
                    return { status: 'CONTINUE', result: `SUCCESS: ${args.path} verified and tests passed.`, latestError: "" };
                } catch (e: any) {
                    // Capture logs to help the agent diagnose the failure
                    const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
                    latestError = out;

                    result = `VALIDATION_FAILED: Tests failed after writing ${args.path}.\n\n--- TEST OUTPUT ---\n${out.slice(-800)}\n------------------\n\nINSTRUCTION: The change was saved but the system is inconsistent. Review the error, update any related files (tests or repositories), and propose a fix.`;

                    console.log(chalk.red(`     ❌ Validation Failed. Logged output to Auditor context.`));
                }
            }
            break;

        case 'list_files':
            const files = await fs.readdir(path.resolve(apiRoot, rawPath || '.'));
            result = files.join(', ');
            break;

        default:
            result = `ERROR: Tool ${name} not found.`;
    }

    // Log to scratchpad
    await updateScratchpad(`
    ### 🛠️ TOOL: ${name}
    **Time:** ${new Date().toLocaleTimeString()}
    **Args:** \`${JSON.stringify(args)}\`
    **Result:** ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}
    ${latestError ? `**Error Context:** ${latestError.slice(0, 200)}...` : ''}
    ---`);

    return { status: 'CONTINUE', result, latestError };
}