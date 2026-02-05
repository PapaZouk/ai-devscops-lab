import OpenAI from 'openai';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { runDiscovery } from './discoveryAgent.js';
import { runDefinition } from './definitionAgent.js';
import { tools } from './tools/tools.js';
import { ensureDir } from './helpers/ensureDir.js';
import { updateScratchpad } from './helpers/updateScratchpad.js';
import { rollbackToSafety } from './helpers/rollbackToSafety.js';
import { handleToolCall } from './handlers/toolHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

const client = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'not-needed',
});

export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  const backupDir = path.resolve(memoryDir, 'backups');
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');

  let latestError = errorLog;

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Discovery`));

  try {
    await runDiscovery(apiRoot);
    console.log(chalk.green(`  ✅ Step 0: Discovery Complete. API Map generated.`));
  } catch (err: any) {
    console.log(chalk.red(`  ⚠️ Discovery Warning: ${err.message}`));
  }

  if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  await ensureDir(backupDir);

  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const contract = await runDefinition(targetFile, initialCode, errorLog);

  console.log(chalk.green(`  ✅ Step 1: Definition Complete. Contract established.`));

  // Terminal UI for Contract display
  const display = (label: string, items: any, color: Function) => {
    console.log(color(`\n─── ${label} ───`));
    if (Array.isArray(items)) {
      items.forEach(i => console.log(chalk.white(`• ${i}`)));
    } else {
      console.log(chalk.white(items || "N/A"));
    }
  };

  display("VULNERABILITY", contract.vulnerability_analysis, chalk.red);
  display("CHANGES", contract.required_changes, chalk.cyan);
  display("INVARIANTS", contract.functional_invariants, chalk.green);

  const backupFileName = `${path.basename(targetFile)}.bak`;
  const backupPath = path.resolve(backupDir, backupFileName);
  await fs.writeFile(backupPath, initialCode, 'utf8');

  const initialLog = `# Remediation Log: ${targetFile}\n\n## Initial Error\n\`\`\`\n${errorLog}\n\`\`\`\n---\n`;
  await fs.writeFile(scratchPath, initialLog, 'utf8');

  // Updated System Prompt: Focuses on Multi-Agent Orchestration and Tool Protocol
  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a Senior Security Orchestrator. 
Your goal is to remediate vulnerabilities defined in the provided CONTRACT while maintaining functional integrity.

### MANDATORY COORDINATION WORKFLOW:
1. DISCOVERY: Map the module dependencies using 'api_directory_helper' and read relevant source/test files.
2. SOURCE FIX: Call 'propose_fix' for the logic changes.
3. COMMIT LOGIC: Once the source fix is APPROVED, you MUST call 'write_fix' for that file immediately.
4. TEST SYNCHRONIZATION: Once the source fix is APPROVED and only after the source file is written to disk, call 'generate_tests'.
5. TEST PROPOSAL: Call 'propose_fix' for the test file using the code provided by the Testing Agent.
6. ATOMIC EXECUTION: Call 'write_fix' only after BOTH the source logic and the test logic have been APPROVED.

### CORE OPERATING RULES:
1. NO HARDCODED LOGIC: Do not store specific implementation details in your prompt memory; rely on tool outputs.
2. MIGRATION TOLERANCE: Do not be discouraged by partial test failures. If 'write_fix' fails validation, analyze the 'latestError' (e.g., missing environment variables or mismatched hashes) and patch the remaining files.
3. MODULE STANDARDS: Strictly use ESM syntax (import/export) and include '.js' extensions in all local paths.
4. INTERFACE PARITY: Preserve original function signatures and exports unless the contract demands a breaking change.
5. RECOVERY: If stuck in a loop, use 'get_knowledge' to retrieve remediation patterns.

### HANDLING VALIDATION FAILURES:
If 'write_fix' returns VALIDATION_FAILED, perform these steps:
1. READ: Examine the "TEST OUTPUT" in the tool result.
2. DIAGNOSE:
   - Is it a Syntax/ESM error? Fix the file mentioned.
   - Is it a 'Module not found' error? Check if the missing file is a dependency you intentionally introduced in your code, or if the Testing Agent hallucinated a file path in the test suite. Ensure the implementation and the tests are using the same directory structure.
   - Is it a Test failure? Use 'generate_tests' again, providing the latest error so the Testing Agent can fix its logic.
3. RECTIFY: Propose and write the missing or corrected files.

### CRITICAL EXECUTION RULE:
- Every file you 'propose_fix' for MUST eventually be applied via 'write_fix' once approved.
- If you have an approved fix for a SOURCE file and an approved fix for a TEST file, you must call 'write_fix' for BOTH files sequentially.
- Validation (npm test) only works if the code on disk matches your proposals. If you only write the source code but leave the old tests on disk, validation WILL fail.

Current Target: ${targetFile}
Contract: ${JSON.stringify(contract, null, 2)}`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    { role: 'user', content: `Begin remediation of ${targetFile}. Current system error state: ${latestError}` }
  ];

  try {
    for (let step = 0; step < 30; step++) {
      console.log(chalk.blue.bold(`\n🔄 Remediation Step [${step + 1}]`));

      const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages,
        tools,
        tool_choice: 'auto'
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (message.content) {
        console.log(chalk.gray(`Thought: ${message.content.trim()}`));
        await updateScratchpad(`THOUGHT: ${message.content.trim()}`);
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        continue;
      }

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;

        const { name, arguments: argsString } = toolCall.function;
        const args = JSON.parse(argsString);

        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));

        try {
          const { status, result, latestError: updatedError } = await handleToolCall(name, args, {
            apiRoot,
            agentRoot,
            initialCode,
            latestError, // Pass the persisting error context
            contract,
            messages
          });

          // Persistent update of the error state for the next LLM turn
          latestError = updatedError;
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

          const hasApprovedFix = messages.some(m =>
            m.role === 'tool' &&
            typeof m.content === 'string' &&
            m.content.startsWith('APPROVED')
          );

          const isTryingToRead = message.tool_calls.some(tc =>
            tc.type === 'function' && tc.function.name === 'read_file'
          );

          if (hasApprovedFix && isTryingToRead) {
            messages.push({
              role: 'user',
              content: `SYSTEM NUDGE: I see you have an APPROVED fix for a file, but you are trying to 'read_file' again. The file on disk has NOT changed yet. You must call 'write_fix' for the approved path immediately to progress.`
            });
          }

          if (result.includes("FILE_NOT_FOUND")) {
            messages.push({
              role: 'user',
              content: `ADVISORY: The file '${args.path}' does not exist. Cross-reference the PROJECT MAP via 'api_directory_helper' to find the correct existing path. Do not attempt to import this non-existent path.`
            });
          }

          // If validation failed, nudge the agent with the specific error and its next task
          if (result.includes("VALIDATION_FAILED")) {
            messages.push({
              role: 'user',
              content: `SYSTEM: Validation failed. 
        IMPORTANT: I noticed the tests are still failing with syntax or environment errors. 
        Did you forget to call 'write_fix' for the TEST file? 
        You must write the APPROVED test code to disk so that 'npm test' can see it.`
            });
          }

          if (status === 'COMPLETE') {
            console.log(chalk.green.bold(`🎉 Remediation Successful! Changes are live and verified.`));
            return `SUCCESS: ${targetFile} verified.`;
          }
        } catch (err: any) {
          console.error(chalk.red(`     🚨 Execution Error: ${err.message}`));
          await rollbackToSafety(apiRoot);
          throw err;
        }
      }
    }
    return "Remediation failed: Maximum orchestration steps reached.";
  } finally {
    console.log(chalk.yellow.bold(`\n🔒 System Shutdown: Cleaning up session...`));
  }
}