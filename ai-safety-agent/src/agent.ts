import OpenAI from 'openai';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { runDiscovery } from './discoveryAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

const client = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'not-needed',
});

// --- HELPERS ---

export async function ensureDir(dirPath: string) {
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
  const normalizedQuery = query.toLowerCase();
  const key = Object.keys(data).find(k => normalizedQuery.includes(k) || k.includes(normalizedQuery));
  return key ? `[REFERENCE: ${data[key].title}]\n${data[key].description}\n\nCODE:\n${data[key].code}` : "No specific match. Use standard ESM.";
}

async function runReviewerAgent(
  filePath: string,
  proposedCode: string,
  originalCode: string,
  evidence: string
): Promise<{ approved: boolean; feedback?: string }> {
  console.log(chalk.magenta(`  🔍 Auditor: Analyzing proposed changes for ${filePath}...`));

  const response = await client.chat.completions.create({
    model: 'google/gemma-3-4b',
    messages: [
      {
        role: 'system',
        content: `You are a Senior DevSecOps Auditor. Your goal is to ensure security improvements do not break system functionality.

            CRITERIA FOR APPROVAL (Must pass all):
            1. SECURITY DELTA: The PROPOSED code must be objectively more secure than the ORIGINAL (e.g., replacing hardcoded strings with environment variables is a SUCCESS).
            2. FUNCTIONAL PARITY: All public exports, functions, and core business logic from the ORIGINAL must exist in the PROPOSED code. Do not accept partial snippets.
            3. MODULE STANDARDS: Must use ESM 'import/export'. No 'require'.
            4. STABILITY: Environment variables must be checked for existence before use (e.g., throwing a clear error if a variable is missing).

            CRITERIA FOR REJECTION:
            - If the agent "hallucinates" new dependencies not found in the original imports.
            - If the agent simplifies the logic so much that it loses original features.
            - If the agent introduces hardcoded fallback values (e.g., const secret = process.env.KEY || 'default').

            Format your response as:
            RESULT: [APPROVED/REJECTED]
            REASON: [Technical explanation of the delta]`
      },
      {
        role: 'user',
        content: `EVIDENCE (Test Failures):\n${evidence}\n\nORIGINAL CODE:\n${originalCode}\n\nPROPOSED CODE:\n${proposedCode}`
      }
    ]
  });

  const content = response.choices[0].message.content || "";
  const isApproved = content.includes("RESULT: APPROVED");

  console.log(chalk.magentaBright(`     Auditor Feedback: ${content.split('\n')[1] || content}`));

  return {
    approved: isApproved,
    feedback: content
  };
}

// --- MAIN REMEDIATOR ---

export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  const backupDir = path.resolve(memoryDir, 'backups');
  const scratchPath = path.resolve(memoryDir, 'scratchpad.md');

  let latestError = errorLog;

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Discovery`));

  // --- NEW: RUN DISCOVERY AGENT FIRST ---
  try {
    console.log(chalk.blue(`  🔍 Step 0: Discovery Agent - Scanning project structure...`));
    await runDiscovery(apiRoot); // We will define this helper below
    console.log(chalk.green(`  ✅ Step 0: Discovery Complete. API Map generated.`));
  } catch (err: any) {
    console.log(chalk.red(`  ⚠️  Discovery Warning: ${err.message}. Proceeding with manual exploration.`));
  }

  console.log(chalk.yellow.bold(`\n🚀 System Startup: Initializing Context & Backups`));

  if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
  await ensureDir(backupDir);

  const initialCode = await fs.readFile(path.resolve(apiRoot, targetFile), 'utf-8');
  const backupFileName = `${path.basename(targetFile)}.bak`;
  const backupPath = path.resolve(backupDir, backupFileName);
  await fs.writeFile(backupPath, initialCode, 'utf8');

  const relativeBackupPath = path.join('.agent_memory', 'backups', backupFileName);
  console.log(chalk.cyan(`  📝 Scratchpad & Backup secured: ${relativeBackupPath}`));

  const initialLog = `# Remediation Log: ${targetFile}\n\n## Initial Error\n\`\`\`\n${errorLog}\n\`\`\`\n---\n`;
  await fs.writeFile(scratchPath, initialLog, 'utf8');

  const systemPrompt: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'system',
    content: `You are a DevSecOps Agent. Your ONLY task is to fix security in '${targetFile}'.
  - DO NOT modify jest.config.js, package.json, or test files.
  - 'write_fix' is a DESTRUCTIVE overwrite. You MUST provide the FULL file content.
  - You MUST preserve original imports like 'import { db } from "../repository/db.js"'.
  - IMPORT STRUCTURE: 'jsonwebtoken' usually requires 'import jwt from "jsonwebtoken"' followed by 'jwt.sign()'. Avoid calling 'sign()' directly unless explicitly imported.
  - Use 'process.env.JWT_SECRET' without hardcoded fallbacks.
  - If tests fail, it is likely because you deleted essential logic or used wrong import syntax.
  - STRICT IMPORTS: Only use packages you see in the original file or package.json. Do not guess package names.`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    { role: 'user', content: `Fix security in ${targetFile}. Error: ${errorLog}` }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'Recursively list files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'search_code', description: 'Search for text in project.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'get_knowledge', description: 'Lookup secure syntax.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    {
      type: 'function',
      function: {
        name: 'write_fix',
        description: 'CRITICAL: This overwrites the entire file. You must include EVERY line of code, all imports, and all functions. Never send snippets.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            code: { type: 'string', description: 'The complete, full source code of the file.' }
          },
          required: ['path', 'code']
        }
      }
    },
    { type: 'function', function: { name: 'propose_fix', description: 'Request audit.', parameters: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] } } },
    {
      type: 'function',
      function: {
        name: 'api_directory_helper',
        description: 'Lookup the verified project map to find services, repositories, and test files.',
        parameters: {
          type: 'object',
          properties: {
            moduleName: { type: 'string', description: 'e.g., "auth", "products"' }
          },
          required: ['moduleName']
        }
      }
    }
  ];

  try {
    for (let step = 0; step < 25; step++) {
      if (step === 15) {
        console.log(chalk.red.bold(`\n🔄 MISSION RECALL: Re-focusing agent...`));
        messages.push({
          role: 'user',
          content: `CRITICAL RECALL: You are here to fix the hardcoded secret in '${targetFile}'. 
        Your previous attempts may have failed because you provided partial code snippets or 
        modified the wrong files. Read '${targetFile}' again, and provide the ENTIRE 
        file content (including all imports) in your next 'write_fix'.`
        });
      }

      console.log(chalk.blue.bold(`\n--- [STEP ${step + 1}/25] ---`));
      const response = await client.chat.completions.create({ model: 'google/gemma-3-4b', messages, tools, tool_choice: 'auto' });
      const message = response.choices[0].message;

      if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
        messages.push({ role: 'user', content: "Use a tool like 'read_file' to continue." });
        continue;
      }

      messages.push(message);
      if (message.content) {
        console.log(chalk.gray(`Thought: ${message.content.trim()}`));
        await updateScratchpad(`THOUGHT: ${message.content.trim()}`);
      }

      for (const toolCall of (message.tool_calls || [])) {
        const { name, arguments: argsString } = toolCall.function;
        let args = JSON.parse(argsString);

        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));
        console.log(chalk.blackBright(`     Args: ${JSON.stringify(args)}`));

        let result = "";
        try {
          if (name === 'get_knowledge') {
            result = await getKnowledgeBase(args.query || args.path || "jwt");
          } else if (name === 'search_code') {
            const out = execSync(`grep -r "${args.query}" . --exclude-dir=node_modules | head -n 20`, { cwd: apiRoot }).toString();
            result = out || "No matches found.";
          } else if (name === 'list_files') {
            const fullPath = path.resolve(apiRoot, args.path || ".");
            const files = await fs.readdir(fullPath, { recursive: true });
            result = files.slice(0, 100).join('\n');
          } else if (name === 'api_directory_helper') {
            const mapPath = path.resolve(agentRoot, 'agent_knowledge/api_map.json');
            if (!fsSync.existsSync(mapPath)) {
              result = "ERROR: API Map not found. Use 'list_files' to explore manually.";
            } else {
              const mapData = JSON.parse(await fs.readFile(mapPath, 'utf8'));
              const info = mapData[args.moduleName] || mapData['auth'];
              result = `VERIFIED PATHS for ${args.moduleName}:\n${JSON.stringify(info, null, 2)}`;
            }
          } else {
            const rawPath = args.path || "";
            if (!rawPath) throw new Error("Agent failed to provide a path.");

            const isInternal = rawPath.startsWith('.agent_memory');
            const fullPath = isInternal ? path.resolve(agentRoot, rawPath) : path.resolve(apiRoot, rawPath);

            console.log(chalk.blue(`     Path Resolved: ${fullPath}`));

            if (name === 'read_file') {
              result = await fs.readFile(fullPath, 'utf-8');
              console.log(chalk.green(`     ✅ Read Successful.`));
            } else if (name === 'write_fix') {
              const hasImports = args.code.includes('import');
              const isTooShort = args.code.length < (initialCode.length * 0.5);

              if (!hasImports || isTooShort) {
                console.log(chalk.red(`     ⚠️  Guard Triggered: Agent tried to write a partial snippet.`));
                result = `REJECTED: You provided a partial snippet. You MUST provide the FULL file content, including all original imports and functions. Length: ${args.code.length} vs Original: ${initialCode.length}`;
              } else {
                await fs.writeFile(fullPath, args.code, 'utf8');
                console.log(chalk.yellow(`     💾 File saved. Running tests...`));

                try {
                  execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
                  execSync('npm test', { cwd: apiRoot, stdio: 'pipe' });
                  return `SUCCESS: ${args.path} verified.`;
                } catch (e: any) {
                  const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
                  latestError = out;
                  console.log(chalk.red(`     ❌ Validation Failed.`));

                  result = `VALIDATION_FAILED. 
                  The tests failed. Check for missing variables (e.g. 'sign' vs 'jwt.sign') or bad imports.
                  TRACE:
                  ${out.slice(0, 500)}`;
                }
              }
            } else if (name === 'propose_fix') {
              const original = await fs.readFile(backupPath, 'utf-8');
              const review = await runReviewerAgent(args.path, args.code, original, latestError);
              result = review.approved ? "APPROVED" : `REJECTED: ${review.feedback}`;
              await updateScratchpad(`AUDITOR REVIEW: ${review.approved ? 'APPROVED' : 'REJECTED'}\nFEEDBACK: ${review.feedback}`);
              console.log(review.approved ? chalk.green(`     ✅ Approved`) : chalk.red(`     ❌ Rejected`));
            }
          }
        } catch (err: any) {
          result = `ERROR: ${err.message}`;
          console.log(chalk.red(`     ⚠️  ${result}`));
        }
        await updateScratchpad(`TOOL: ${name} | RESULT: ${result.slice(0, 100)}...`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
    }
    return "Failed.";
  } finally {
    // Keep memory for analysis
  }
}

export async function rollbackToSafety(apiRoot: string) {
  const memoryDir = path.resolve(agentRoot, '.agent_memory');
  try {
    if (fsSync.existsSync(memoryDir)) await fs.rm(memoryDir, { recursive: true, force: true });
    execSync('git reset --hard HEAD', { cwd: apiRoot, stdio: 'ignore' });
    execSync('git clean -fd', { cwd: apiRoot, stdio: 'ignore' });
  } catch (err) { }
}