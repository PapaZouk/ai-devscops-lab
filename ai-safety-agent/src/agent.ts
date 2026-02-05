import OpenAI from 'openai';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

const client = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'not-needed',
});

// --- HELPERS ---

async function ensureDir(dirPath: string) {
  if (!fsSync.existsSync(dirPath)) await fs.mkdir(dirPath, { recursive: true });
}

async function updateScratchpad(content: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  await ensureDir(memoryDir);
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');
  const timestamp = new Date().toLocaleTimeString();
  const entry = `\n### [${timestamp}] LOG ENTRY\n${content}\n---\n`;
  await fs.appendFile(scratchPath, entry, 'utf8');
}

async function runReviewerAgent(
  filePath: string,
  proposedCode: string,
  originalCode: string,
  evidence: string
): Promise<{ approved: boolean; feedback?: string }> {
  console.log(chalk.magenta(`  🔍 Auditor: Analyzing proposed changes...`));

  const response = await client.chat.completions.create({
    model: 'google/gemma-3-4b',
    messages: [
      {
        role: 'system',
        content: `You are a Technical Auditor.
          AUDIT PROTOCOL:
          1. CONTRACT: Maintain signatures for functions like login/verifyToken.
          2. LOGIC: Do not delete existing imports or DB calls.
          3. SECRETS: Replacing hardcoded strings with 'process.env.VARIABLE' is MANDATORY.`
      },
      {
        role: 'user',
        content: `ORIGINAL:\n${originalCode}\n\nPROPOSED:\n${proposedCode}\n\nEVIDENCE:\n${evidence}`
      }
    ]
  });

  const content = response.choices[0].message.content?.trim() || "";
  const approved = content.toUpperCase().startsWith("APPROVED");
  return { approved, feedback: content };
}

// --- MAIN REMEDIATOR ---

export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  const backupDir = path.resolve(memoryDir, 'backups');
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');

  let latestError = errorLog;
  let lastActionKey = "";
  let repeatCount = 0;
  let pathErrorCount = 0;

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Backups`));

  // 1. Initial Cleanup: Fresh start for session
  if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  await ensureDir(backupDir);

  // 2. Backup Ground Truth
  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const backupFileName = `${path.basename(targetFile)}.bak`;
  const backupPath = path.resolve(backupDir, backupFileName);
  await fs.writeFile(backupPath, initialCode, 'utf8');
  const relativeBackupPath = path.relative(agentRoot, backupPath);

  console.log(chalk.cyan(`  📦 Backup secured: ${relativeBackupPath}`));

  // 3. Initialize Scratchpad: Ensure file exists before agent starts thinking
  const initialLog = `# Remediation Log: ${targetFile}\n\n## Initial Error\n\`\`\`\n${errorLog}\n\`\`\`\n---\n`;
  await fs.writeFile(scratchPath, initialLog, 'utf8');
  console.log(chalk.dim(`  📝 Scratchpad initialized: .agent_memory/scratchpad.md`));

  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a DevSecOps Agent. Only modify '${targetFile}'. Ground truth is at '${relativeBackupPath}'. Use FULL content for code writes.`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    { role: 'user', content: `Fix security issues in ${targetFile}. Initial Error: ${errorLog}` }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'propose_fix', description: 'Request audit. Code MUST be FULL content.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } },
    { type: 'function', function: { name: 'write_fix', description: 'Commit code. Code MUST be FULL content.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } }
  ];

  try {
    for (let step = 0; step < 25; step++) {
      if (step === 15) {
        console.log(chalk.magenta("\n🔄 Step 15: Pruning heavy context..."));
        messages = [systemPrompt, { role: 'user', content: `Resetting. Please read the backup at ${relativeBackupPath} and try one last time.` }];
      }

      console.log(chalk.blue.bold(`\n--- [STEP ${step + 1}/25] ---`));

      const response = await client.chat.completions.create({
        model: 'google/gemma-3-4b',
        messages,
        tools,
        tool_choice: 'auto',
      });

      const message = response.choices[0].message;

      if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
        console.log(chalk.red(`  ⚠️ Agent Stall: Sending nudge...`));
        const nudge = {
          role: 'user' as const,
          content: "You haven't called a tool or provided a thought. Please proceed by either proposing a fix or reading a file."
        };
        messages.push(nudge);
        continue;
      }

      messages.push(message);

      if (message.content) {
        console.log(chalk.gray(`Thought: ${message.content.trim()}`));
      }

      const toolCalls = message.tool_calls || [];
      for (const toolCall of toolCalls) {
        const { name, arguments: argsString } = toolCall.function;
        console.log(chalk.cyan.bold(`\n  🛠️  TOOL CALL: ${name}`));

        let args;
        try {
          args = JSON.parse(argsString);
        } catch (e) {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: "ERROR: Invalid JSON in arguments." });
          continue;
        }

        if (!args.path) {
          pathErrorCount++;
          if (pathErrorCount >= 2) {
            console.log(chalk.red("  🚨 Argument loop detected. Resetting context."));
            messages = [systemPrompt, { role: 'user', content: "Use the path argument correctly. Read the target file first." }];
            break;
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: "ERROR: Missing path." });
          continue;
        }
        pathErrorCount = 0;

        const safePath = args.path.replace(/^(\.\.\/)+/, '');
        const isMemory = safePath.endsWith('.bak') || safePath.includes('scratchpad');
        const root = isMemory ? agentRoot : apiRoot;
        const targetPath = (isMemory && safePath.includes('scratchpad')) ? '.agent_memory/scratchpad.md' : safePath;

        let result = "";
        try {
          if (name === 'read_file') {
            result = await fs.readFile(path.resolve(root, targetPath), 'utf-8');
            console.log(chalk.green(`  ✅ Read successful.`));
          } else if (name === 'propose_fix') {
            const original = await fs.readFile(backupPath, 'utf-8');
            const review = await runReviewerAgent(args.path, args.code, original, latestError);
            result = review.approved ? "APPROVED" : `REJECTED: ${review.feedback}`;
            console.log(review.approved ? chalk.green.bold("  ✅ APPROVED") : chalk.red("  ❌ REJECTED"));
          } else if (name === 'write_fix') {
            const fullPath = path.resolve(apiRoot, safePath);
            await fs.writeFile(fullPath, args.code, 'utf8');
            try {
              console.log(chalk.blue(`  🧹 Biome: Linting...`));
              execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
              console.log(chalk.yellow(`  🧪 Vitest: Testing...`));
              execSync('npm test', { cwd: apiRoot, stdio: 'pipe' });
              console.log(chalk.green.bold(`  🎊 Remediated successfully!`));
              return `SUCCESS: ${args.path} verified.`;
            } catch (e: any) {
              const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
              latestError = out;
              console.log(chalk.red(`  ❌ Validation Failure.`));
              await updateScratchpad(`Test Error in ${args.path}:\n${out.slice(-1000)}`);
              result = `VALIDATION_FAILED. Terminal output: ${out.slice(0, 250)}...`;
            }
          }
        } catch (err: any) {
          result = `ERROR: ${err.message}`;
          console.log(chalk.red(`  ❌ ${result}`));
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
    }
    return "Failed.";
  } finally {
    console.log(chalk.dim(`\n🧹 Cleaning up session memory...`));
    // Optional: Keep memory if you want to inspect scratchpad.md after failure
    // If so, comment out the line below:
    if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  }
}

export async function rollbackToSafety(apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  try {
    if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
    execSync('git reset --hard HEAD', { cwd: apiRoot, stdio: 'ignore' });
    console.log(chalk.green("✅ Environment restored."));
  } catch (err) { }
}