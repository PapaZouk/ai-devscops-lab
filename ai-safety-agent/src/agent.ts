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

/**
 * The Reviewer Agent: Compares proposed code against the original backup.
 * Updated to encourage process.env usage and strictly check for deleted logic.
 */
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
          1. CONTRACT: The code MUST still export the same functions (e.g., login, verifyToken).
          2. LOGIC: Do not delete database calls, imports, or Zod schemas unless they are the bug.
          3. SECRETS: Replacing hardcoded strings with 'process.env.VARIABLE' is HIGHLY APPROVED. 
          
          Respond 'APPROVED' if signatures are preserved and the fix is valid.
          Otherwise, respond 'REJECTED' + identify the specific missing export or broken logic.`
      },
      {
        role: 'user',
        content: `ORIGINAL:\n${originalCode}\n\nPROPOSED:\n${proposedCode}\n\nEVIDENCE:\n${evidence}`
      }
    ]
  });

  const content = response.choices[0].message.content?.trim() || "";
  const approved = content.toUpperCase().startsWith("APPROVED");

  if (!approved) {
    console.log(chalk.redBright(`  ⚠️ Auditor Feedback: ${content.slice(0, 150)}...`));
  }

  return { approved, feedback: content };
}

export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  const backupDir = path.resolve(memoryDir, 'backups');
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');

  let latestError = errorLog;
  let lastActionKey = "";
  let repeatCount = 0;

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Backups`));

  // CLEAR OLD MEMORY FIRST
  if (fsSync.existsSync(memoryDir)) {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }

  await ensureDir(backupDir);
  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const backupPath = path.resolve(backupDir, `${path.basename(targetFile)}.bak`);
  await fs.writeFile(backupPath, initialCode, 'utf8');
  console.log(chalk.cyan(`  📦 Backup secured: ${path.relative(process.cwd(), backupPath)}`));

  await fs.writeFile(scratchPath, `# Audit Log\nTarget: ${targetFile}\n\n## Initial Failure\n${errorLog}\n`, 'utf8');

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a DevSecOps Agent. 
        - MANDATORY: Use 'read_file' to see ACTUAL content before thinking.
        - DO NOT assume or simulate code.
        - Use 'propose_fix' for audit before 'write_fix'. 
        - IMPORTANT: When using 'propose_fix' or 'write_fix', you MUST provide the FULL content of the file, not just the changed lines.
        - CONTRACT: You must fix the security issue without deleting existing exports or core logic.`
    },
    {
      role: 'user',
      content: `Fix vulnerabilities in ${targetFile}. Base code and error logs are provided in memory.`
    }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'propose_fix', description: 'Request audit. Code MUST be the FULL file content.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } },
    { type: 'function', function: { name: 'write_fix', description: 'Commit code. Code MUST be the FULL file content.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } }
  ];

  for (let step = 0; step < 25; step++) {
    console.log(chalk.blue.bold(`\n--- [STEP ${step + 1}/25] ---`));

    const response = await client.chat.completions.create({
      model: 'google/gemma-3-4b',
      messages,
      tools,
      tool_choice: 'auto',
    });

    const message = response.choices[0].message;
    messages.push(message);

    // --- STALL DETECTION ---
    if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
      console.log(chalk.red(`  ⚠️ Agent Stall: Nudging...`));
      const nudge = `SYSTEM: You are stuck. 
      1. If your fix was APPROVED but tests failed, read the scratchpad to see the TEST ERROR.
      2. Do not delete existing 'import' statements if file requires them.
      3. If you see that something is undefined, you likely accidentally deleted the import line.`;
      messages.push({ role: 'user', content: nudge });
      continue;
    }

    if (message.content) console.log(chalk.gray(`Thought: ${message.content.trim()}`));

    const toolCalls = message.tool_calls || [];
    for (const toolCall of toolCalls) {
      const { name, arguments: argsString } = toolCall.function;
      let args;
      try { args = JSON.parse(argsString); } catch (e) { continue; }

      console.log(chalk.cyan.bold(`\n  🛠️  TOOL CALL: ${name}`));

      // --- GUARD CLAUSE: Protect against 'replace' on undefined ---
      if (!args.path) {
        console.log(chalk.red(`  ❌ Error: Agent omitted 'path' argument.`));
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: "ERROR: Missing 'path' argument. Please specify the target file path."
        });
        continue;
      }

      // Safe path normalization
      const safePath = args.path.replace(/^(\.\.\/)+/, '');
      console.log(chalk.dim(`     Path: ${safePath}`));

      const isMemory = safePath.toLowerCase().includes('scratchpad');
      const root = isMemory ? agentRoot : apiRoot;
      const targetPath = (isMemory && !safePath.includes('.agent_memory')) ? '.agent_memory/scratchpad.md' : safePath;

      const currentActionKey = `${name}:${targetPath}`;
      if (currentActionKey === lastActionKey) {
        repeatCount++;
        console.log(chalk.bgRed.white(`  🔄 REPETITION DETECTED`));
      } else {
        repeatCount = 0;
        lastActionKey = currentActionKey;
      }

      if (repeatCount >= 2) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: "ERROR: You are repeating tool calls. Explore other files or check your logic." });
        continue;
      }

      let result = "";
      try {
        if (name === 'read_file') {
          result = await fs.readFile(path.resolve(root, targetPath), 'utf-8');
          console.log(chalk.green(`  ✅ Read successful.`));
        }
        else if (name === 'list_files') {
          const files = await fs.readdir(path.resolve(apiRoot, safePath));
          result = `Files: ${files.join(', ')}`;
          console.log(chalk.green(`  ✅ Listed files.`));
        }
        else if (name === 'propose_fix') {
          const original = await fs.readFile(backupPath, 'utf-8');
          const review = await runReviewerAgent(args.path, args.code, original, latestError);
          result = review.approved ? "APPROVED" : `REJECTED: ${review.feedback}`;
          if (!review.approved) latestError = review.feedback || "Rejected by Auditor.";
          console.log(review.approved ? chalk.green.bold("  ✅ APPROVED") : chalk.red("  ❌ REJECTED"));
          await updateScratchpad(`Review: ${result}`);
        }
        else if (name === 'write_fix') {
          const fullPath = path.resolve(apiRoot, safePath);
          await fs.writeFile(fullPath, args.code, 'utf8');
          try {
            console.log(chalk.blue(`  🧹 Biome: Linting...`));
            execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
            console.log(chalk.yellow(`  🧪 Vitest: Testing...`));
            execSync('npm test', { cwd: apiRoot, stdio: 'pipe' });
            return `SUCCESS: ${args.path} verified.`;
          } catch (e: any) {
            // Capture the full output from the test runner
            const stdout = e.stdout?.toString() || "";
            const stderr = e.stderr?.toString() || "";
            const fullTrace = `${stdout}\n${stderr}`.trim();

            latestError = fullTrace || e.message;
            console.log(chalk.red(`  ❌ Validation Failure. Check scratchpad.`));

            // Log the ACTUAL failure to the scratchpad so the agent knows WHY it failed
            await updateScratchpad(`Test Failure Trace:\n${fullPath}\n${fullTrace.slice(-500)}`);
            result = `VALIDATION_FAILED. The tests failed with this message: ${fullTrace.slice(0, 200)}...`;
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
}

export async function rollbackToSafety(apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  try {
    if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
    execSync('git reset --hard HEAD', { cwd: apiRoot, stdio: 'ignore' });
    console.log(chalk.green("✅ Environment restored."));
  } catch (err) { }
}