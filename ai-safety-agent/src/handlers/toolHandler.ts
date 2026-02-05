import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { getKnowledgeBase } from '../tools/getKnowledgeBase.js';
import { runReviewerAgent } from '../reviewerAgent.js';
import { updateScratchpad } from '../helpers/updateScratchpad.js';
import { runTestingAgent } from '../testingAgent.js';

interface ToolContext {
    apiRoot: string;
    agentRoot: string;
    initialCode: string;
    latestError: string;
    contract: any;
    messages: any[];
}

export async function handleToolCall(name: string, args: any, context: ToolContext) {
    const { apiRoot, agentRoot, contract, messages } = context;
    let result = "";
    let latestError = context.latestError;

    // PATH SANITIZATION LOGIC
    const rawPath = args.path || "";
    const isInternal = rawPath.startsWith('.agent_memory');
    const fullPath = isInternal ? path.resolve(agentRoot, rawPath) : path.resolve(apiRoot, rawPath);

    // Verify path is within allowed roots
    if (!fullPath.startsWith(apiRoot) && !fullPath.startsWith(agentRoot)) {
        return { status: 'CONTINUE', result: "ERROR: Access denied. Path is outside project root.", latestError };
    }

    const getApiMap = async () => {
        try {
            const mapPath = path.resolve(agentRoot, 'agent_knowledge/api_map.json');
            return await fs.readFile(mapPath, 'utf8');
        } catch { return "{}"; }
    };

    switch (name) {
        case 'get_knowledge':
            result = await getKnowledgeBase(args.query || args.path || "security");
            console.log(chalk.cyan(`     ✅ Knowledge retrieved.`));
            break;

        case 'api_directory_helper':
            const mapData = JSON.parse(await getApiMap());
            const moduleKey = Object.keys(mapData).find(k => k.toLowerCase().includes(args.moduleName?.toLowerCase() || ""));
            result = JSON.stringify(moduleKey ? mapData[moduleKey] : "Module not found.", null, 2);
            console.log(moduleKey ? chalk.green(`     ✅ Context mapped.`) : chalk.red(`     ❌ Module missing.`));
            break;

        case 'read_file':
            try {
                const stats = await fs.stat(fullPath);
                if (stats.isDirectory()) {
                    result = `DIRECTORY_ERROR: '${args.path}' is a directory.`;
                } else {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    result = `FILE_CONTENTS [${args.path}]:\n\n${content}`;
                    console.log(chalk.green(`     ✅ Read ${args.path}`));
                }
            } catch (e: any) {
                result = `FILE_NOT_FOUND: ${args.path} does not exist.`;
                console.log(chalk.yellow(`     ⚠️  File missing: ${args.path}`));
            }
            break;

        case 'propose_fix':
            console.log(chalk.blue(`     🔍 Reviewer Agent: Auditing ${args.path}...`));
            let currentFileCode = "";
            try {
                currentFileCode = await fs.readFile(fullPath, 'utf-8');
            } catch {
                currentFileCode = "// New file";
            }
            const audit = await runReviewerAgent(args.path, args.code, currentFileCode, latestError, contract);
            result = audit.approved ? `APPROVED: ${args.path}` : `REJECTED: ${audit.feedback}`;
            console.log(audit.approved ? chalk.green.bold(`     ✅ Approved ${args.path}`) : chalk.red.bold(`     ❌ Rejected.`));
            break;

        case 'write_fix':
            const lastApproval = [...messages].reverse().find(m =>
                m.role === 'tool' && m.content === `APPROVED: ${args.path}`
            );

            if (!lastApproval) {
                result = `REJECTED: ${args.path} not approved.`;
                console.log(chalk.yellow.bold(`     ⚠️ Safety: Blocked write.`));
            } else {
                await fs.writeFile(fullPath, args.code, 'utf8');
                console.log(chalk.yellow(`     💾 Saved ${args.path}. Validating...`));
                try {
                    try {
                        execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
                    } catch { }

                    execSync('node --experimental-vm-modules node_modules/jest/bin/jest.js', {
                        cwd: apiRoot,
                        stdio: 'pipe',
                        env: {
                            ...process.env,
                            NODE_ENV: 'test',
                            NODE_OPTIONS: '--experimental-vm-modules --no-warnings'
                        }
                    });

                    console.log(chalk.green.bold(`     ✅ SUCCESS: Tests passed.`));
                    return { status: 'CONTINUE', result: `SUCCESS: ${args.path} verified.`, latestError: "" };
                } catch (e: any) {
                    const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
                    latestError = out;
                    result = `VALIDATION_FAILED: ${args.path}\n\n${out.slice(-800)}`;
                    console.log(chalk.red(`     ❌ Validation Failed.`));
                }
            }
            break;

        case 'generate_tests':
            console.log(chalk.magenta(`     🧪 Testing Agent: Generating suite...`));
            const mapRaw = await getApiMap();
            const currentApiMap = JSON.parse(mapRaw);

            const moduleEntry = Object.values(currentApiMap).find((m: any) =>
                m.logic.includes(args.path) || args.path.includes(m.logic.replace('./', ''))
            ) as any;

            const targetTestPath = moduleEntry?.tests || `tests/${path.basename(args.path).replace('.ts', '.test.ts')}`;

            const testCode = await runTestingAgent(
                targetTestPath,
                args.implementationCode,
                contract,
                latestError,
                JSON.stringify(moduleEntry)
            );

            result = `TARGET_PATH: ${targetTestPath}\n\n${testCode}`;
            console.log(chalk.green(`     ✅ Test suite generated for ${targetTestPath}`));
            break;
        default:
            result = `ERROR: Tool ${name} not found.`;
    }

    // UPDATED SCRATCHPAD LOGGING (MORE DETAILED)
    await updateScratchpad(`
### 🛠️ TOOL: ${name}
**Path:** ${args.path || 'N/A'}
**Result:** ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}
---`);

    return { status: 'CONTINUE', result, latestError };
}