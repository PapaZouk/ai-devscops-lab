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

async function getKnowledgeBase(query: string): Promise<string> {
  const kbPath = path.resolve(__dirname, '../agent_knowledge/remediation_examples.json');

  const library: Record<string, any> = {
    jwt: { title: "JWT Security", code: "import jwt from 'jsonwebtoken';\nconst token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256' });" },
    zod: { title: "Zod Validation", code: "import { z } from 'zod';\nconst schema = z.object({ email: z.string().email() });" },
    env: { title: "Env Vars", code: "const secret = process.env.JWT_SECRET; // Never hardcode defaults" }
  };

  if (!fsSync.existsSync(kbPath)) {
    const key = Object.keys(library).find(k => query.toLowerCase().includes(k));
    return key ? `[REFERENCE] ${library[key].code}` : "Use process.env and standard ESM imports.";
  }

  const data = JSON.parse(await fs.readFile(kbPath, 'utf8'));
  const key = Object.keys(data).find(k => query.toLowerCase().includes(k) || k.includes(query.toLowerCase()));
  return key ? `[REFERENCE: ${data[key].title}]\n${data[key].description}\n\nCODE:\n${data[key].code}` : "No specific match. Use standard ESM.";
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
        content: `You are a Technical Auditor. REJECT if: 1. Hardcoded secrets remain. 2. Broken ESM syntax.`
      },
      { role: 'user', content: `ORIGINAL:\n${originalCode}\n\nPROPOSED:\n${proposedCode}` }
    ]
  });
  const content = response.choices[0].message.content?.trim() || "";
  return { approved: content.toUpperCase().startsWith("APPROVED"), feedback: content };
}

// --- MAIN REMEDIATOR ---

export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  const backupDir = path.resolve(memoryDir, 'backups');
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');

  let latestError = errorLog;

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Backups`));

  if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  await ensureDir(backupDir);

  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const backupFileName = `${path.basename(targetFile)}.bak`;
  const backupPath = path.resolve(backupDir, backupFileName);
  await fs.writeFile(backupPath, initialCode, 'utf8');

  // Important: Give the agent a path relative to the AGENT ROOT for backups
  const relativeBackupPath = path.join('.agent_memory', 'backups', backupFileName);

  console.log(chalk.cyan(`  📦 Backup secured: ${relativeBackupPath}`));

  const initialLog = `# Remediation Log: ${targetFile}\n\n## Initial Error\n\`\`\`\n${errorLog}\n\`\`\`\n---\n`;
  await fs.writeFile(scratchPath, initialLog, 'utf8');

  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a DevSecOps Agent. Only modify '${targetFile}'. 
    - Ground truth: '${relativeBackupPath}'
    - Knowledge: Use 'get_knowledge' for syntax.
    - Pathing: Files starting with '.agent_memory' are your own internal files.`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    { role: 'user', content: `Fix security in ${targetFile}. Error: ${errorLog}` }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List files in directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'get_knowledge', description: 'Lookup secure syntax.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'write_fix', description: 'Commit code.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } },
    { type: 'function', function: { name: 'propose_fix', description: 'Request audit.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } }
  ];

  try {
    for (let step = 0; step < 25; step++) {
      if (step === 15) {
        messages = [systemPrompt, { role: 'user', content: `Context Reset. Use 'read_file' on ${relativeBackupPath} and try again.` }];
      }

      console.log(chalk.blue.bold(`\n--- [STEP ${step + 1}/25] ---`));
      const response = await client.chat.completions.create({ model: 'google/gemma-3-4b', messages, tools, tool_choice: 'auto' });
      const message = response.choices[0].message;

      if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
        messages.push({ role: 'user', content: "Use a tool to proceed." });
        continue;
      }

      messages.push(message);
      if (message.content) {
        console.log(chalk.gray(`Thought: ${message.content.trim()}`));
        await updateScratchpad(`THOUGHT: ${message.content.trim()}`);
      }

      for (const toolCall of (message.tool_calls || [])) {
        const { name, arguments: argsString } = toolCall.function;
        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));
        let args = JSON.parse(argsString);
        let result = "";

        try {
          if (name === 'get_knowledge') {
            result = await getKnowledgeBase(args.query || args.path || "jwt");
          } else if (name === 'list_files') {
            const fullPath = path.resolve(apiRoot, args.path || ".");
            const files = await fs.readdir(fullPath);
            result = files.join('\n');
          } else {
            // --- UPDATED PATH RESOLUTION ---
            const isInternal = args.path.startsWith('.agent_memory');
            const fullPath = isInternal
              ? path.resolve(agentRoot, args.path)
              : path.resolve(apiRoot, args.path);

            if (name === 'read_file') {
              result = await fs.readFile(fullPath, 'utf-8');
              console.log(chalk.green(`  ✅ Read successful from ${isInternal ? 'Memory' : 'Project'}.`));
            } else if (name === 'write_fix') {
              await fs.writeFile(fullPath, args.code, 'utf8');
              try {
                execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
                execSync('npm test', { cwd: apiRoot, stdio: 'pipe' });
                return `SUCCESS: ${args.path} verified.`;
              } catch (e: any) {
                const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
                latestError = out;
                await updateScratchpad(`Test Failure:\n${out.slice(-500)}`);
                result = `VALIDATION_FAILED. Trace: ${out.slice(0, 250)}`;
              }
            } else if (name === 'propose_fix') {
              const original = await fs.readFile(backupPath, 'utf-8');
              const review = await runReviewerAgent(args.path, args.code, original, latestError);
              result = review.approved ? "APPROVED" : `REJECTED: ${review.feedback}`;
            }
          }
        } catch (err: any) {
          result = `ERROR: ${err.message}`;
          console.log(chalk.red(`  ❌ ${result}`));
        }

        await updateScratchpad(`TOOL: ${name} | RESULT: ${result.slice(0, 100)}...`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
    }
    return "Failed.";
  } finally {
    // Keep memory for debugging if needed, cleanup happens in rollback
  }
}

export async function rollbackToSafety(apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  try {
    if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
    execSync('git reset --hard HEAD', { cwd: apiRoot, stdio: 'ignore' });
  } catch (err) { }
}