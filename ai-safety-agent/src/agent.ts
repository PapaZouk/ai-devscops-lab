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
    content: `You are a Senior Security Orchestrator. 
Your goal is to remediate vulnerabilities defined in the provided CONTRACT while maintaining functional integrity.

### THE SOURCE OF TRUTH (KNOWLEDGE BASE):
- Before implementing security patterns, you MUST call 'get_knowledge'.
- You are forbidden from guessing library syntax.

### TOOL SELECTION HEURISTICS:
- **Environment Errors:** For "Module Not Found" errors, call 'run_command' for npm installs. DO NOT modify code to remove the dependency.
- **Protocol:** Use 'propose_fix' for logic. Only use 'write_fix' after receiving an 'APPROVED' status.
- **Recovery:** Use 'checkpoint_manager' to 'load' a previously APPROVED state if you get stuck.

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

      // --- TOKEN LEAKAGE PROTECTION ---
      if (message.content?.includes('<|channel|>')) {
        console.log(chalk.red(`  ⚠️ Detected Model Fizzle (Internal Tokens). Triggering Reset...`));
        messages.push({ role: 'user', content: "SYSTEM: You are outputting internal control tokens. Please return to standard JSON tool calling format immediately." });
        continue;
      }

      const estimatedTokens = estimateTokenCount(messages);
      const remainingPercent = Math.max(0, 100 - (estimatedTokens / 131072 * 100));

      // IMPORTANT LOG: Context Monitoring
      console.log(chalk.magenta(`  📊 Context Monitor: ~${Math.round(estimatedTokens)} tokens used (${remainingPercent.toFixed(1)}% remaining)`));

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

        // IMPORTANT LOG: Tool Initialization
        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));

        try {
          const { status, result, latestError: updatedError } = await handleToolCall(name, args, {
            apiRoot, agentRoot, initialCode, latestError, contract, messages
          });

          latestError = updatedError || latestError;
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

          // --- CONDITIONAL APPROVAL & RECOVERY LOGIC ---

          if (name === 'propose_fix') {
            const isApproved = result.includes('APPROVED');
            const isMinor = result.includes('SEVERITY: MINOR');

            if (isApproved) {
              console.log(chalk.green(`  💾 Auto-saving checkpoint for approved logic...`));
              await checkpointManager('save', args.path, args.code);

              if (isMinor) {
                messages.push({
                  role: 'user',
                  content: `The Auditor APPROVED your fix but noted MINOR issues. Before calling 'write_fix', please address this: ${result.split('REASON:')[1]}`
                } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
                continue;
              }
            }
          }

          // Handle Missing Modules (npm install fix)
          if (result.includes("VALIDATION_FAILED") && result.includes("Cannot find module")) {
            const moduleName = result.match(/module '(.+?)'/)?.[1] || "the package";
            messages.push({
              role: 'user',
              content: `ENVIRONMENT ERROR: Missing module '${moduleName}'. Call 'run_command' {"command": "npm install ${moduleName}"} then re-attempt 'write_fix'.`
            } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
          }

          // Loop Breaking (Checkpoint Load)
          const recentRejections = messages.slice(-10).filter(m => m.role === 'tool' && (m.content.includes("REJECTED") || m.content.includes("VALIDATION_FAILED"))).length;
          if (recentRejections >= 2 || step > 15) {
            messages.push({
              role: 'user',
              content: `RECOVERY NUDGE: You are looping. Use 'checkpoint_manager' to 'load' the last APPROVED code.`
            } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
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