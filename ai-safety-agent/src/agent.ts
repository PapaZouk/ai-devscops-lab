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

### TOOL SELECTION HEURISTICS:
- **Project Context:** Use 'api_directory_helper' followed by 'read_file' if you lack path/dependency clarity.
- **Environment Errors:** If 'write_fix' fails with Syntax/Import/Module errors, you MUST use 'get_knowledge'.
- **Testing Requirements:** Once code is written, you MUST use 'generate_tests' to synchronize the environment.
- **Protocol:** Use 'propose_fix' for logic. Only use 'write_fix' after receiving an 'APPROVED' status.

### THE "RESEARCH-FIRST" TRIGGER:
- If 'write_fix' returns VALIDATION_FAILED due to environment/module issues, your NEXT tool call MUST be 'get_knowledge'.
- If 'propose_fix' is REJECTED twice, you MUST research standard patterns via 'get_knowledge' before re-proposing.

### MANDATORY COORDINATION WORKFLOW:
1. DISCOVERY: Map dependencies and read relevant source/test files.
2. SOURCE FIX: Call 'propose_fix' for logic changes.
3. COMMIT SOURCE: Once APPROVED, you MUST call 'write_fix' immediately.
4. TEST ALIGNMENT: After 'write_fix' (even if it fails), call 'generate_tests' to synchronize.
5. TEST PROPOSAL: Call 'propose_fix' for the test file.
6. FINAL VALIDATION: Call 'write_fix' for the test file.

### CORE OPERATING RULES:
1. NO HARDCODED LOGIC: Rely on tool outputs, 'get_knowledge', and the CONTRACT.
2. RESEARCH-FIRST: Use 'get_knowledge' to resolve technical roadblocks before guessing syntax.
3. STRATEGY LOCK: Maintain approved security levels (e.g. Asymmetric vs Symmetric) even when fixing syntax.
4. MODULE STANDARDS: Strictly use ESM with '.js' extensions. No TypeScript annotations.

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

      const contextLimit = 131072;
      const estimatedTokens = estimateTokenCount(messages);
      const remainingPercent = Math.max(0, 100 - (estimatedTokens / contextLimit * 100));

      console.log(chalk.magenta(`  📊 Context Monitor: ~${Math.round(estimatedTokens)} tokens used (${remainingPercent.toFixed(1)}% remaining)`));

      if (remainingPercent < 20) {
        console.log(chalk.red.bold(`  ⚠️ WARNING: Context window nearly full! Consider summarizing scratchpad.`));
      }

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
            apiRoot,
            agentRoot,
            initialCode,
            latestError,
            contract,
            messages
          });

          latestError = updatedError;
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

          // 1. GENERIC DEPENDENCY & EXPORT ALIGNMENT
          const isValidationError = result.includes("VALIDATION_FAILED");
          const isDependencyIssue = isValidationError &&
            (result.toLowerCase().includes("module") || result.toLowerCase().includes("export"));

          if (isDependencyIssue) {
            messages.push({
              role: 'user',
              content: `ENVIRONMENT MISMATCH DETECTED: 
              - Your implementation uses a module or export pattern not supported by the current environment.
              - You MUST call 'get_knowledge' to research correct patterns.
              - You MUST verify 'package.json' via 'read_file' to confirm installed dependencies.
              - Stop guessing; align your imports with the actual environment now.`
            } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
          }

          // 2. REJECTION LOOP DETECTION
          const recentRejections = messages.slice(-8).filter(m => {
            if (m.role === 'tool' && typeof m.content === 'string') {
              return m.content.includes("REJECTED") || m.content.includes("VALIDATION_FAILED");
            }
            return false;
          }).length;

          if (recentRejections >= 2 && !isDependencyIssue) {
            messages.push({
              role: 'user',
              content: `SYSTEM ADVISORY: You are stuck in a loop. Use 'get_knowledge' and 'api_directory_helper' to reconcile your implementation with the environment.`
            } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
          }

          // 3. STUCK ON READ DETECTION
          const recentAssistantMsgs = messages.slice(-6).filter(m => m.role === 'assistant');
          const readCount = recentAssistantMsgs.filter(m =>
            m.tool_calls?.some(tc => tc.function.name === 'read_file')
          ).length;

          if (readCount >= 3) {
            messages.push({
              role: 'user',
              content: `STUCK DETECTED: Multiple 'read_file' calls without progress. You MUST 'propose_fix' or use 'get_knowledge' now.`
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