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

  console.log(chalk.magenta.bold(`\n─── REMEDIATION CONTRACT: ${targetFile} ───`));

  const display = (label: string, items: any, color: Function) => {
    console.log(color(`\n${label}:`));
    if (Array.isArray(items)) {
      items.forEach(i => console.log(chalk.white(`• ${i}`)));
    } else {
      console.log(chalk.white(items || "N/A"));
    }
  };

  display("VULNERABILITY", contract.vulnerability_analysis, chalk.red);
  display("CHANGES", contract.required_changes, chalk.cyan);
  display("INVARIANTS", contract.functional_invariants, chalk.green);

  console.log(chalk.magenta(`\n${"─".repeat(targetFile.length + 30)}\n`));
  const backupFileName = `${path.basename(targetFile)}.bak`;
  const backupPath = path.resolve(backupDir, backupFileName);
  await fs.writeFile(backupPath, initialCode, 'utf8');

  const initialLog = `# Remediation Log: ${targetFile}\n\n## Initial Error\n\`\`\`\n${errorLog}\n\`\`\`\n---\n`;
  await fs.writeFile(scratchPath, initialLog, 'utf8');

  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a Senior DevSecOps Remediation Agent. 
Your logic, technical standards, and success criteria are strictly governed by the following REMEDIATION CONTRACT:

${JSON.stringify(contract, null, 2)}

MANDATORY WORKFLOW:
1. ANALYZE: Use 'api_directory_helper' and 'read_file' to understand the local environment, dependencies, and related test files.
2. PROPOSE: You MUST call 'propose_fix' and receive an "APPROVED" response before applying any changes.
3. EXECUTE: Call 'write_fix' only after receiving "APPROVED". If 'write_fix' fails validation, you must re-analyze and propose a new fix.

CORE OPERATING RULES:
1. CONTRACT ADHERENCE: Follow 'required_changes' and 'functional_invariants' exactly. Do not add features outside the contract.
2. SCOPE & TEST ALIGNMENT: Your primary target is ${targetFile}, but you are REQUIRED to update related test files if your security changes cause existing tests to fail. Do not ignore test failures; fix the tests to match the new secure logic.
3. MODULE STANDARDS: Strictly use ESM 'import/export' syntax. Ensure all local imports include the '.js' extension (e.g., import { x } from './file.js'). NEVER use 'require'.
4. NO FALLBACKS: When handling environment variables, you must throw a hard error if they are missing. Do not use insecure fallbacks (e.g., ?? 'secret').
5. RECOVERY PROTOCOL: If 'write_fix' fails validation or 'propose_fix' is rejected more than twice, you MUST call 'get_knowledge' with the query 'remediation examples' to align with proven security patterns.
6. FULL FILE WRITES: The 'write_fix' tool requires the 100% complete source code of the file. Do not use placeholders or comments.
7. NO HALLUCINATIONS: Never simulate tool output (e.g., tool_result) in your thought process. Only react to actual tool output provided by the system.`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    { role: 'user', content: `TASK: Remediate ${targetFile} based on the contract.` }
  ];

  try {
    for (let step = 0; step < 25; step++) {
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
        const wasApproved = messages.some(m => m.role === 'tool' && m.content.includes('APPROVED'));

        const nudgeMessage = wasApproved
          ? "The fix was APPROVED. You must now call 'write_fix' to apply the changes."
          : "Please proceed with the next step using the available tools.";

        messages.push({ role: 'user', content: `SYSTEM: ${nudgeMessage}` });
        continue;
      }

      for (const toolCall of (message.tool_calls || [])) {
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

          if (status === 'COMPLETE') {
            console.log(chalk.green.bold(`🎉 Remediation Successful! Changes are live.`));
            return `SUCCESS: ${targetFile} verified.`;
          }
        } catch (err: any) {
          console.error(chalk.red(`     🚨 Execution Error: ${err.message}`));
          await rollbackToSafety(apiRoot);
          throw err;
        }
      }
    }
    return "Remediation failed after max steps.";
  } finally {
    console.log(chalk.yellow.bold(`\n🔒 System Shutdown: Cleaning up session...`));
  }
}