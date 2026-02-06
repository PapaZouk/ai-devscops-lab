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
import { estimateTokenCount } from './utils/estimateTokenCount.js';
import { checkpointManager } from './tools/checkpointManager.js';

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

  // Clear previous session memory
  if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  await ensureDir(backupDir);

  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const contract = await runDefinition(targetFile, initialCode, errorLog);

  console.log(chalk.green(`  ✅ Step 1: Definition Complete. Contract established.`));

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

  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a Senior TypeScript Security Architect.
Your goal is to remediate vulnerabilities defined in the CONTRACT while maintaining functional integrity.

### MANDATORY TYPESCRIPT RULES:
1. **EXTENSIONS:** Use ONLY '.ts' extensions. NEVER use '.js' in code or filenames.
2. **IMPORTS:** Ensure all imports are valid TypeScript/ESM. No guessing.
3. **SYNTAX:** Use modern TypeScript. Do not include type annotations if the environment is strictly JS-runtime, but the file MUST be saved as .ts.

### WORKFLOW GATES (STRICT ENFORCEMENT):
- **Knowledge First:** Before implementing any fix, you MUST call 'get_knowledge' to retrieve verified security patterns.
- **Verification Gate:** You are FORBIDDEN from concluding remediation until you have called 'generate_tests' and successfully verified the fix with a test suite.
- **Recovery:** If a fix fails validation (tests fail), do not ignore it. Fix the code or the test suite. If looping, use 'checkpoint_manager' to 'load' the last APPROVED state.

### DYNAMIC DEPENDENCY MANAGEMENT:
- If 'write_fix' fails with "Module Not Found", identify the missing package, call 'run_command' to install it, and re-attempt the write.

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

      // Protection against internal token leakage
      if (message.content?.includes('<|channel|>')) {
        messages.push({ role: 'user', content: "SYSTEM: Internal token leakage detected. Please return to standard JSON tool calling format." });
        continue;
      }

      const estimatedTokens = estimateTokenCount(messages);
      console.log(chalk.magenta(`  📊 Context Monitor: ~${Math.round(estimatedTokens)} tokens used (~${Math.max(0, 100 - (estimatedTokens / 131072 * 100)).toFixed(1)}% remaining)`));

      messages.push(message);

      if (message.content) {
        console.log(chalk.gray(`Thought: ${message.content.trim()}`));
        await updateScratchpad(`THOUGHT: ${message.content.trim()}`);
      }

      if (!message.tool_calls || message.tool_calls.length === 0) continue;

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;

        const { name, arguments: argsString } = toolCall.function;
        const args = JSON.parse(argsString);

        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));

        try {
          const { status, result, latestError: updatedError } = await handleToolCall(name, args, {
            apiRoot, agentRoot, initialCode, latestError, contract, messages
          });

          latestError = updatedError || latestError;
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

          // --- GENERALIZED LOGIC GATES ---

          // 1. Checkpoint for Approved Logic
          if (name === 'propose_fix' && result.includes('APPROVED')) {
            const isMinor = result.includes('SEVERITY: MINOR');
            await checkpointManager('save', args.path, args.code);
            console.log(chalk.green(`  💾 Auto-saving checkpoint for approved logic...`));

            if (isMinor) {
              messages.push({ role: 'user', content: `The Auditor approved with MINOR feedback. Refine the code: ${result.split('REASON:')[1]}` });
              continue;
            }
          }

          // 2. TypeScript/ESM Enforcement
          if (args.path && args.path.endsWith('.js')) {
            messages.push({ role: 'user', content: "ERROR: You used a .js extension. Rename the file to .ts and ensure TypeScript syntax is used." });
          }

          // 3. Dynamic Dependency Installation
          if (result.includes("VALIDATION_FAILED") && result.includes("Cannot find module")) {
            const pkg = result.match(/module '(.+?)'/)?.[1] || "the missing package";
            messages.push({
              role: 'user',
              content: `The module '${pkg}' is missing. Use 'run_command' to install it. Do not change the logic.`
            });
          }

          // 4. Testing Gate Enforcement
          if (name === 'write_fix' && !args.path.includes('.test.ts') && !args.path.includes('.spec.ts')) {
            messages.push({ role: 'user', content: "Source updated. Now call 'generate_tests' to verify the fix before finishing." });
          }

          // 4.1 If they call 'write_fix' on a test file, enforce that it must be followed by a successful 'generate_tests' before allowing 'finish'.
          if (name === 'write_fix' && status === 'SUCCESS') {
            messages.push({
              role: 'user',
              content: `File written. You MUST now call 'run_biome_check' for '${args.path}' to ensure no syntax or linting errors were introduced before proceeding to testing.`
            });
          }

          // 5. Loop Recovery
          const recentFailures = messages.slice(-10).filter(m => m.role === 'tool' && (m.content.includes("REJECTED") || m.content.includes("VALIDATION_FAILED"))).length;
          if (recentFailures >= 2) {
            messages.push({ role: 'user', content: "You are stuck in a failure loop. Call 'checkpoint_manager' (action: 'load') to restore the last approved version." });
          }

          // 6. Verification check on Finish
          if (status === 'COMPLETE') {
            const testsRun = messages.some(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.function.name === 'generate_tests'));
            if (!testsRun) {
              messages.push({ role: 'user', content: "You cannot finish. You must call 'generate_tests' and verify with a 'write_fix' for the test file first." });
              continue;
            }
            console.log(chalk.green.bold(`🎉 Remediation Successful! verified via Test Specialist.`));
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