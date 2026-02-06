import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { getKnowledgeBase } from '../tools/getKnowledgeBase.js';
import { runReviewerAgent } from '../reviewerAgent.js';
import { updateScratchpad } from '../helpers/updateScratchpad.js';
import { runTestingAgent } from '../testingAgent.js';
import { checkpointManager } from '../tools/checkpointManager.js';
import { getBiomeDiagnostics } from '../scanners/getBiomeDiagnostics.js';
import { execPromise } from '../helpers/execPromise.js';

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

    // --- PATH RESOLUTION & SAFETY ---
    const rawPath = args.path || "";
    const isInternal = rawPath.startsWith('.agent_memory');
    const fullPath = isInternal ? path.resolve(agentRoot, rawPath) : path.resolve(apiRoot, rawPath);

    if (!fullPath.startsWith(apiRoot) && !fullPath.startsWith(agentRoot)) {
        return { status: 'CONTINUE', result: "ERROR: Access denied. Path is outside project root.", latestError };
    }

    const getApiMap = async () => {
        try {
            const mapPath = path.resolve(agentRoot, 'agent_knowledge/api_map.json');
            return JSON.parse(await fs.readFile(mapPath, 'utf8'));
        } catch { return {}; }
    };

    switch (name) {
        // 1. KNOWLEDGE RETRIEVAL
        case 'get_knowledge':
            result = await getKnowledgeBase(args.query || args.path || "security");
            console.log(chalk.cyan(`     ✅ Knowledge retrieved.`));
            break;

        // 2. STATE MANAGEMENT (Checkpoints)
        case 'checkpoint_manager':
            result = await checkpointManager(args.action, args.path, args.content);
            console.log(chalk.blue(`     💾 Checkpoint ${args.action.toUpperCase()} for ${args.path}`));
            break;

        // 3. PROJECT DISCOVERY (Fuzzy Mapping)
        case 'api_directory_helper': {
            const mapData = await getApiMap();
            const query = args.moduleName?.toLowerCase() || "";

            // Search keys, logic paths, and test paths for the query
            const moduleKey = Object.keys(mapData).find(k =>
                k.toLowerCase().includes(query) ||
                JSON.stringify(mapData[k]).toLowerCase().includes(query)
            );

            if (moduleKey) {
                result = JSON.stringify({ module: moduleKey, ...mapData[moduleKey] }, null, 2);
                console.log(chalk.green(`     ✅ Context mapped: ${moduleKey}`));
            } else {
                const suggestions = Object.keys(mapData).slice(0, 5).join(', ');
                result = `❌ Module '${args.moduleName}' not found. Available: ${suggestions}`;
                console.log(chalk.red(`     ❌ Module missing.`));
            }
            break;
        }

        // 4. FILE SYSTEM: READ
        case 'read_file':
            try {
                const stats = await fs.stat(fullPath);
                if (stats.isDirectory()) {
                    const files = await fs.readdir(fullPath);
                    result = `DIRECTORY_LISTING [${args.path}]:\n${files.join('\n')}`;
                } else {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    result = `FILE_CONTENTS [${args.path}]:\n\n${content}`;
                    console.log(chalk.green(`     ✅ Read ${args.path}`));
                }
            } catch (e: any) {
                result = `FILE_NOT_FOUND: ${args.path}`;
            }
            break;

        // 5. SECURITY AUDIT GATE
        case 'propose_fix': {
            // 1. PATH VALIDATION (The "Front Desk" Check)
            const isTestFile = args.path.includes('.test.');
            const isWrongFolder = isTestFile && args.path.startsWith('src/');

            if (isWrongFolder) {
                result = `❌ REJECTED: PATH_MISPLACEMENT
                PATH: ${args.path}
                REASON: You are attempting to place a TEST file inside the 'src/' directory.
                CRITICAL RULE: All test files must be located in the 'tests/' directory (e.g., 'tests/integration/authService.test.ts').

                REQUIRED ACTION:
                1. Identify the correct test path from 'api_map.json'.
                2. Call 'propose_fix' again with the correct path.`;

                console.log(chalk.red.bold(`     ⚠️ Auditor blocked misaligned path: ${args.path}`));
                return { status: 'CONTINUE', result, latestError };
            }

            // 2. PROCEED TO AUDIT
            console.log(chalk.blue(`     🔍 Reviewer Agent: Auditing ${args.path}...`));
            let currentFileCode = "";
            try {
                currentFileCode = await fs.readFile(fullPath, 'utf-8');
            } catch {
                currentFileCode = "// New file";
            }

            const audit = await runReviewerAgent(args.path, args.code, currentFileCode, latestError, contract);

            if (audit.approved) {
                const type = isTestFile ? 'TEST_SUITE' : 'SOURCE_CODE';
                result = `APPROVED: ${args.path}
                FILE_TYPE: ${type}

                CRITICAL: This approval is ONLY for ${args.path}.
                NEXT STEP: You must now call 'write_fix' for the EXACT path: '${args.path}'.
                Do not attempt to write this code to any other file.`;

                console.log(chalk.green.bold(`     ✅ Approved ${args.path}`));
            } else {
                result = `REJECTED: ${audit.feedback}

                REQUIRED ACTION: Fix the issues identified by the Auditor and call 'propose_fix' again.`;

                console.log(chalk.red.bold(`     ❌ Rejected.`));
            }
            break;
        }

        // 6. FILE SYSTEM: WRITE (Strict Approval Check)
        case 'write_fix': {
            // 1. Find the most recent approval in the message history
            const lastApprovalMessage = [...messages].reverse().find(m =>
                m.role === 'tool' && m.content?.includes('APPROVED:')
            );

            let isApproved = false;
            let approvedPathRaw = "NONE";

            if (lastApprovalMessage) {
                // Extract path after 'APPROVED: ' but before any newlines
                const match = lastApprovalMessage.content.match(/APPROVED:\s*([^\n]+)/);
                if (match) {
                    approvedPathRaw = match[1].trim();

                    // Normalize both paths to absolute paths to ensure a fair comparison
                    const absoluteApprovedPath = path.resolve(apiRoot, approvedPathRaw);
                    const absoluteTargetPath = path.resolve(apiRoot, args.path);

                    isApproved = absoluteApprovedPath === absoluteTargetPath;
                }
            }

            // 2. Safety Gate: Block if not approved
            if (!isApproved) {
                result = `❌ ERROR: WRITE_BLOCKED
                    PATH: ${args.path}
                    REASON: This specific path has not been approved by the Auditor.
                    LAST_APPROVED_PATH: ${approvedPathRaw}

                    REQUIRED ACTION:
                    1. You MUST call 'propose_fix' for '${args.path}' before you can write it.
                    2. An approval for one file (e.g., source) does NOT authorize writing to another (e.g., test).
                    3. If the paths look the same, check for typos or directory depth errors.
                `;

                console.log(chalk.red.bold(`     ⚠️ Safety: Blocked write for ${args.path}. Path mismatch.`));
                return { status: 'CONTINUE', result, latestError };
            }

            // 3. Execution: Write to disk
            try {
                await fs.writeFile(fullPath, args.code, 'utf8');

                // Flush-left result to prevent token bloat
                result = `💾 STATUS: FILE_WRITTEN
                    PATH: ${args.path}

                    CRITICAL NEXT STEP:
                    1. You MUST now call 'run_biome_check' on '${args.path}' immediately.
                    2. If this is a TEST file and Biome passes, proceed to 'run_command' with 'npm test'.
                    3. If this is SOURCE code and Biome passes, proceed to 'generate_tests'.`;

                console.log(chalk.yellow(`     💾 Saved ${args.path}.`));
            } catch (error: any) {
                result = `❌ ERROR: Failed to write to disk: ${error.message}`;
                console.log(chalk.red(`     ❌ Disk Error: ${error.message}`));
                return { status: 'CONTINUE', result, latestError };
            }
            break;
        }

        // 7. QUALITY GATE: BIOME LINTING
        case 'run_biome_check': {
            const fullPath = path.resolve(apiRoot, args.path);
            const diagnostics = await getBiomeDiagnostics(fullPath);

            if (!diagnostics || diagnostics.length === 0) {
                // Fetch current content to "ground" the agent and prevent re-reads
                const currentContent = await fs.readFile(fullPath, 'utf-8');
                const lines = currentContent.split('\n');
                const snapshot = lines.length > 10
                    ? `${lines.slice(0, 5).join('\n')}\n... [TRUNCATED] ...\n${lines.slice(-5).join('\n')}`
                    : currentContent;

                result = `✅ STATUS: BIOME_PASSED
                    FILE: ${args.path}
                    STATE: LOCKED & VERIFIED

                    SUMMARY: The file is perfectly formatted and passes all security-lint rules.

                    INTERNAL SNAPSHOT (Current State):
                    ${snapshot}

                    -----------------------------------------------------------------------
                    🚀 DIRECTIVE: 
                    1. The source code in '${args.path}' is now a "Ground Truth" artifact. 
                    2. DO NOT call 'read_file' or 'propose_fix' for this file again.
                    3. NEXT STEP: Call 'generate_tests' to validate these changes.
                    4. Your focus MUST now shift entirely to the test suite.`;

                console.log(chalk.green(`     ✅ Biome passed & State Locked: ${args.path}`));
            } else {
                const hasFixable = diagnostics.some(d => d.code?.includes('format') || d.code?.includes('organizeImports'));
                const summary = diagnostics.slice(0, 5).map(d => `• [${d.code}] ${d.message}`).join('\n');

                result = `❌ STATUS: BIOME_FAILED
                    FILE: ${args.path}
                    STATE: DIRTY (NEEDS REPAIR)

                    ISSUES DETECTED:
                    ${summary}
                    ${diagnostics.length > 5 ? `...and ${diagnostics.length - 5} more issues.` : ''}

                    ${hasFixable ? `💡 AUTO-FIX AVAILABLE:
                    Run 'run_command' with: "npx @biomejs/biome check --write ${args.path}" to fix formatting and imports automatically.` : ''}

                    REQUIRED ACTION: You must resolve these issues. Use the auto-fix command if available, then YOU MUST RE-RUN 'run_biome_check'.`;

                console.log(chalk.red(`     ❌ Biome failed: ${args.path}`));
            }
            break;
        }

        // 8. TEST GENERATION (Specialist Agent)
        case 'generate_tests': {
            console.log(chalk.magenta(`     🧪 Testing Agent: Generating suite...`));
            const currentApiMap = await getApiMap();
            const moduleEntry = Object.values(currentApiMap).find((m: any) =>
                m?.logic?.includes(args.path) || args.path.includes(m.logic?.replace('./', ''))
            ) as any;

            // Normalize path: Ensure no leading './' to prevent string mismatch in Safety Gate
            let targetTestPath = moduleEntry?.tests || `tests/${path.basename(args.path).replace(/\.ts$/, '')}.test.ts`;
            targetTestPath = targetTestPath.replace(/^\.\//, '');

            const testCode = await runTestingAgent(targetTestPath, args.implementationCode, contract, latestError, JSON.stringify(moduleEntry || {}));

            result = `✅ STATUS: TESTS_GENERATED
                TARGET_PATH: ${targetTestPath} 

                --- CODE START ---
                ${testCode}
                --- CODE END ---

                CRITICAL NEXT STEPS:
                1. Call 'propose_fix' with:
                - path: "${targetTestPath}"
                - code: (The code provided above)
                2. Once APPROVED, call 'write_fix' for the same path.
                3. Call 'run_biome_check' on "${targetTestPath}".
                4. Call 'run_command' with "npm test".

                🛑 STOP: Do not read more files or research. Complete the write/test loop now.`;

            console.log(chalk.green(`     ✅ Test suite generated for ${targetTestPath}`));
            break;
        }

        // 9. COMMAND EXECUTION (Dependency/Test Runner)
        case 'run_command': {
            const cmd = args.command;
            const allowedPrefixes = ['npm install', 'npm list', 'npm test', 'npx @biomejs', 'ls', 'npm run'];

            if (!allowedPrefixes.some(p => cmd.startsWith(p))) {
                result = `❌ REJECTED: Command '${cmd}' is restricted for security. Only npm/npx/ls commands are allowed.`;
                return { status: 'CONTINUE', result, latestError: 'Restricted Command' };
            }

            try {
                const { stdout, stderr } = await execPromise(cmd, { cwd: apiRoot });

                // Success path
                const isTest = cmd.includes('npm test');
                result = `✅ COMMAND SUCCESS: ${cmd}
                    STDOUT:
                    ${stdout}

                    ${isTest ? '🎉 STATUS: TESTS_PASSED. If all security goals are met, you are finished.' : 'NEXT: Proceed with the remediation sequence.'}`;

                console.log(chalk.green(`     ✅ Command Success: ${cmd}`));
            } catch (err: any) {
                const stdout = err.stdout || "";
                const stderr = err.stderr || "";

                // Smart Error Diagnosis (Logic in code, not prompt)
                const isMissingDep = stderr.includes('Cannot find module') || stdout.includes('Cannot find module');
                const isAuthError = stderr.includes('JWT_SECRET') || stdout.includes('JWT_SECRET');

                result = `❌ COMMAND FAILED: ${cmd}
                    ERROR SUMMARY:
                    ${stderr || err.message}

                    ${isMissingDep ? "💡 DIAGNOSIS: A dependency or file is missing. Check your imports and 'package.json'." : ""}
                    ${isAuthError ? "💡 DIAGNOSIS: Environment variable JWT_SECRET is missing. Ensure the test setup mocks process.env." : ""}

                    REQUIRED ACTION: Fix the error above and re-run the command. Do not ignore failing tests.`;

                console.log(chalk.red(`     ❌ Command Failed: ${cmd}`));
            }
            break;
        }

        // 10. STATUS CHECKER
        case 'get_status': {
            const absoluteTargetPath = path.resolve(apiRoot, args.path);
            const fileName = path.basename(args.path);

            // Filter messages with robust path matching
            const relevantTools = messages.filter(m => {
                if (m.role !== 'tool' || !m.content) return false;
                // Match by full path, relative path, or just filename to be safe
                return m.content.includes(args.path) || m.content.includes(fileName);
            });

            // Logic gates based on tool output markers
            const hasApproval = relevantTools.some(m => m.content?.includes('APPROVED:'));
            const isWritten = relevantTools.some(m => m.content?.includes('FILE_WRITTEN'));
            const isLinted = relevantTools.some(m => m.content?.includes('BIOME_PASSED'));
            const hasTests = relevantTools.some(m => m.content?.includes('TESTS_GENERATED'));
            const testsPassed = relevantTools.some(m => m.content?.includes('TESTS_PASSED') || (m.content?.includes('PASS') && m.content?.toLowerCase().includes('test')));

            // Determine the single most important next step
            let nextStep = "";
            if (!hasApproval) {
                nextStep = "Call 'propose_fix' to get the Auditor's approval for your changes.";
            } else if (!isWritten) {
                nextStep = "The code is APPROVED. You MUST now call 'write_fix' to save it to disk.";
            } else if (!isLinted) {
                nextStep = "The file is saved, but not verified. Call 'run_biome_check' immediately.";
            } else if (!hasTests && !args.path.includes('.test.')) {
                nextStep = "Source code is ready. Call 'generate_tests' to create the verification suite.";
            } else if (!testsPassed) {
                nextStep = "Code and tests are ready. Call 'run_command' with 'npm test' to finish.";
            } else {
                nextStep = "Remediation is complete and verified. Move to the next vulnerability or signal completion.";
            }

            // Flush-left output to save tokens and improve LLM readability
            result = `📊 STATUS REPORT: ${args.path}
            - Approved: ${hasApproval ? '✅' : '❌'}
            - Written to Disk: ${isWritten ? '✅' : '❌'}
            - Biome/Lint Passed: ${isLinted ? '✅' : '❌'}
            - Tests Generated: ${hasTests ? '✅' : '❌'}
            - Tests Passed: ${testsPassed ? '✅' : '❌'}

            🚀 REQUIRED ACTION: ${nextStep}

            🛑 IMPORTANT: If you are already approved, do not research more. Execute the write/check sequence now.`;

            console.log(chalk.blue(`     📊 Status checked for ${args.path}`));
            break;
        }

        default:
            result = `ERROR: Tool ${name} not found.`;
    }

    // UPDATE SCRATCHPAD FOR AGENT PERSISTENCE
    await updateScratchpad(`\n### 🛠️ TOOL: ${name}\n**Path:** ${args.path || 'N/A'}\n**Result:** ${result.slice(0, 800)}${result.length > 800 ? '...' : ''}\n---`);

    return { status: 'CONTINUE', result, latestError };
}