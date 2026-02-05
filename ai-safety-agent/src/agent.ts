import OpenAI from 'openai';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { runDiscovery } from './discoveryAgent.js';
import { runReviewerAgent } from './reviewerAgent.js';
import { runDefinition } from './definitionAgent.js';
import { tools } from './tools/tools.js';
import { getKnowledgeBase } from './tools/getKnowledgeBase.js';
import { ensureDir } from './helpers/ensureDir.js';
import { updateScratchpad } from './helpers/updateScratchpad.js';
import { rollbackToSafety } from './helpers/rollbackToSafety.js';

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

  console.log(chalk.magenta.bold(`\n📋 REMEDIATION CONTRACT: ${targetFile}`));
  console.table({
    "Vulnerability": { detail: contract.vulnerability_analysis },
    "Security Standard": { detail: contract.security_standard },
    "Required Changes": { detail: contract.required_changes.join(' | ') },
    "Invariants": { detail: contract.functional_invariants.join(' | ') }
  });
  console.log("\n");

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
    1. ANALYZE: Use 'api_directory_helper' and 'read_file' to understand the local environment.
    2. PROPOSE: You MUST call 'propose_fix' and receive an "APPROVED" response before applying changes.
    3. EXECUTE: Call 'write_fix' only after approval.

    CORE OPERATING RULES:
    1. CONTRACT ADHERENCE: Follow 'required_changes' and 'functional_invariants' exactly as defined in the contract.
    2. FULL FILE WRITES: The 'write_fix' tool requires the 100% complete source code of the file.
    3. NO HALLUCINATIONS: Never simulate tool output (e.g., tool_result) in your text responses.
    4. PATH SAFETY: Verify paths represent files, not directories, before calling 'read_file'.`
  };

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemPrompt,
    {
      role: 'user',
      content: `TASK: Remediate ${targetFile} based on the contract. Begin by mapping the module dependencies.`
    }
  ];

  try {
    for (let step = 0; step < 25; step++) {
      console.log(chalk.blue.bold(`\n🔄 Remediation Step [${step + 1}]`));
      const helperCalls = messages.filter(m =>
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => tc.function.name === 'api_directory_helper')
      ).length;

      if (helperCalls > 2) {
        messages.push({ role: 'user', content: "SYSTEM: Loop detected. You have sufficient directory context. Use 'read_file' on the target and its dependencies to proceed." });
        console.log(chalk.red.bold(`  ⚠️ Loop Guard: Forcing transition from discovery to execution.`));
        continue;
      }

      const response = await client.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL_NAME || 'openai/gpt-oss-20b',
        messages,
        tools,
        tool_choice: 'auto'
      });

      const message = response.choices[0].message;

      if (message.content?.includes("tool_result") || message.content?.includes("END_TOOL_RESULT")) {
        messages.push({ role: 'user', content: "CRITICAL: Detected simulated tool output. Do not hallucinate results; use the provided tools and wait for the system response." });
        console.log(chalk.red.bold(`  ⚠️ Hallucination Guard: Blocked simulated tool response.`));
        continue;
      }

      if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
        messages.push({ role: 'user', content: "Please provide a thought process and your next tool call." });
        console.log(chalk.yellow.bold(`  ⚠️ Empty Response Guard: Requesting continuation.`));
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
        let result = "";

        console.log(chalk.cyan.bold(`\n  🛠️  TOOL: ${name}`));

        try {
          if (name === 'get_knowledge') {
            result = await getKnowledgeBase(args.query || args.path || "security");
            console.log(chalk.cyan(`     ✅ Knowledge retrieved (${result.length} chars).`));
          } else if (name === 'api_directory_helper') {
            const mapPath = path.resolve(agentRoot, 'agent_knowledge/api_map.json');
            const mapData = JSON.parse(await fs.readFile(mapPath, 'utf8'));
            const target = args.moduleName?.toLowerCase();
            const moduleKey = Object.keys(mapData).find(k => k.toLowerCase().includes(target || ""));
            result = JSON.stringify(moduleKey ? mapData[moduleKey] : "Module context not found.", null, 2);
            console.log(moduleKey ? chalk.green(`     ✅ Context mapped for ${moduleKey}`) : chalk.red(`     ❌ Module context missing.`));
          } else {
            const rawPath = args.path || "";
            if (!rawPath) throw new Error("Path argument is missing.");

            const isInternal = rawPath.startsWith('.agent_memory');
            const fullPath = isInternal ? path.resolve(agentRoot, rawPath) : path.resolve(apiRoot, rawPath);

            if (name === 'read_file') {
              const stats = await fs.stat(fullPath);
              if (stats.isDirectory()) {
                result = `ERROR: '${args.path}' is a directory. Please provide a specific file path.`;
                console.log(chalk.red(`     ❌ Safety: Prevented directory read.`));
              } else {
                result = await fs.readFile(fullPath, 'utf-8');
                console.log(chalk.green(`     ✅ Read ${args.path} (${result.length} chars)`));
              }
            } else if (name === 'write_fix') {
              // Check if the Reviewer Agent (propose_fix) has already given an "APPROVED" response in this conversation
              const wasApproved = messages.some(m => m.role === 'tool' && m.content === 'APPROVED');

              if (!wasApproved) {
                result = `REJECTED: You must call 'propose_fix' and receive an "APPROVED" status before calling 'write_fix'.`;
                console.log(chalk.yellow.bold(`     ⚠️  Security Bypass Attempt: Agent tried to write without Auditor approval.`));
              } else if (!args.code.includes('import') && !args.code.includes('require')) {
                // Adjusted to support both ESM and CJS dynamically
                result = `REJECTED: Partial code snippet. Provide the 100% complete file content including imports/requires.`;
                console.log(chalk.red(`     ❌ Guard: Blocked partial file write (Missing imports).`));
              } else if (args.code.length < (initialCode.length * 0.6)) {
                result = `REJECTED: Submission is too short (~${args.code.length} chars). Original was ~${initialCode.length}. Provide the FULL file.`;
                console.log(chalk.red(`     ❌ Guard: Blocked partial file write (Length check).`));
              } else {
                await fs.writeFile(fullPath, args.code, 'utf8');
                console.log(chalk.yellow(`     💾 Changes saved. Initiating validation...`));
                try {
                  // Run linting and tests
                  execSync(`npx @biomejs/biome check --write ${fullPath}`, { cwd: apiRoot, stdio: 'pipe' });
                  execSync('npm test', { cwd: apiRoot, stdio: 'pipe' });
                  console.log(chalk.green.bold(`     ✅ SUCCESS: All tests passed and code linted.`));
                  return `SUCCESS: ${args.path} verified.`;
                } catch (e: any) {
                  const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
                  latestError = out;
                  result = `VALIDATION_FAILED: ${out.slice(0, 800)}\n\nINSTRUCTION: Analyze the test failure below. Adjust your code and call 'propose_fix' again before retrying 'write_fix'.`;
                  console.log(chalk.red(`     ❌ Validation Failed: Error feedback sent to agent.`));
                }
              }
            } else if (name === 'propose_fix') {
              console.log(chalk.blue(`     🔍 Reviewer Agent: Auditing proposed fix...`));
              const audit = await runReviewerAgent(args.path, args.code, initialCode, latestError, contract);
              result = audit.approved ? "APPROVED" : `REJECTED: ${audit.feedback}`;
              if (audit.approved) {
                console.log(chalk.green.bold(`     ✅ Auditor: Approved.`));
              } else {
                console.log(chalk.red.bold(`     ❌ Auditor: Rejected - ${audit.feedback}`));
              }
            }
          }
        } catch (err: any) {
          console.error(chalk.red(`     🚨 Execution Error: ${err.message}`));
          await rollbackToSafety(apiRoot);
          throw err;
        }

        await updateScratchpad(`TOOL: ${name} | RESULT: ${result.slice(0, 100)}...`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
    }
    return "Remediation failed after max steps.";
  } finally {
    console.log(chalk.yellow.bold(`\n🔒 System Shutdown: Cleaning up session...`));
  }
}