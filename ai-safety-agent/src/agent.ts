import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

const client = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'not-needed',
});

/**
 * Main agent loop that handles reasoning and tool execution
 */
export async function runSmartRemediator(targetFile: string, errorLog: string, apiRoot: string) {
  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a Senior DevSecOps Engineer. Root directory: ${apiRoot}

      PROJECT CONTEXT:
      - This is a TypeScript ESM project ("type": "module").
      - ALL imports of local files MUST use the '.js' extension even for '.ts' source files.
      - Example: import { db } from "../repository/db.js";

      CRITICAL INSTRUCTIONS:
      1. When using 'write_fix', provide the FULL source code.
      2. For JWT: Use 'HS256' and 'process.env.JWT_SECRET'.
      3. JSON FORMATTING: Output ONLY raw JSON. Never use [TOOL_REQUEST] tags.
      4. DO NOT escape single quotes (\') inside JSON strings. Use standard single quotes.
      5. If 'read_file' fails for a .js file, try reading the .ts version instead.`
    },
    { role: 'user', content: `Fix security vulnerabilities in ${targetFile}. Report: \n${errorLog}` }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in a directory to verify paths',
        parameters: {
          type: 'object',
          properties: { dir: { type: 'string', description: 'Relative path from root' } },
          required: ['dir']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative path to file' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_fix',
        description: 'Overwrites a file with new code and runs npm test immediately.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            code: { type: 'string', description: 'The full source code of the file' }
          },
          required: ['path', 'code']
        }
      }
    }
  ];

  for (let step = 0; step < 10; step++) {
    const response = await client.chat.completions.create({
      model: 'google/gemma-3-4b',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 2500, // Increased to prevent JSON cutoff
    });

    const message = response.choices[0].message;
    let toolCalls = message.tool_calls || [];

    // --- 🚩 DEFENSIVE EXTRACTION & ILLEGAL ESCAPE FIX ---
    if (toolCalls.length === 0 && message.content) {
      const jsonMatch = message.content.match(/\{[\s\S]*"name"[\s\S]*\}/);

      if (jsonMatch) {
        let rawJson = jsonMatch[0]
          .replace(/\\'/g, "'") // Fix illegal escaped single quotes
          .replace(/\[TOOL_REQUEST\]/g, "") // Strip LM Studio specific tags
          .replace(/\[END_TOOL_REQUEST\]/g, "");

        console.log(chalk.magenta("  🔍 Manual Extraction: Cleaning and parsing tool call..."));

        try {
          const parsed = JSON.parse(rawJson);
          toolCalls = [{
            id: `manual-${Date.now()}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || { path: parsed.path, code: parsed.code })
            }
          }];
        } catch (e) {
          console.log(chalk.red("  ❌ JSON still malformed. Prompting AI for correction."));
        }
      }
    }

    messages.push(message);

    if (message.content) {
      console.log(chalk.gray(`\nThought [Step ${step + 1}]: ${message.content.trim()}`));
    }

    if (toolCalls.length === 0) {
      return message.content || "Agent ended without success.";
    }

    for (const toolCall of toolCalls) {
      const { name, arguments: argsString } = toolCall.function;
      let args;

      try {
        args = JSON.parse(argsString.trim().replace(/^`+json|`+$/g, '').replace(/\\'/g, "'"));
      } catch (e) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: "Error: Invalid JSON. Check your escaping." });
        continue;
      }

      console.log(chalk.cyan(`  [Action] Calling ${name}...`));
      let result = "";

      try {
        if (name === 'list_files') {
          const files = await fs.readdir(path.resolve(apiRoot, args.dir));
          result = JSON.stringify({ files });
        }

        else if (name === 'read_file') {
          // Automatic TS/JS resolution
          let filePath = path.resolve(apiRoot, args.path);
          if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) {
            filePath += '.ts';
          }
          result = await fs.readFile(filePath, 'utf-8');
        }

        else if (name === 'write_fix') {
          const fullPath = path.resolve(apiRoot, args.path);
          await fs.writeFile(fullPath, args.code, 'utf8');

          try {
            console.log(chalk.yellow(`  🧪 Running Tests...`));
            // Force ESM support in Jest if needed
            execSync('NODE_OPTIONS="--experimental-vm-modules" npm test', { cwd: apiRoot, stdio: 'pipe', encoding: 'utf8' });
            return `SUCCESS: ${args.path} fixed and verified.`;
          } catch (testErr: any) {
            const output = testErr.stdout || testErr.stderr || testErr.message;
            result = JSON.stringify({
              status: "TESTS_FAILED",
              terminalOutput: output.slice(-800)
            });
            console.log(chalk.red("  ❌ Tests failed."));
          }
        }
      } catch (err: any) {
        result = JSON.stringify({ status: "ERROR", message: err.message });
      }

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  return "Maximum attempts reached.";
}

export async function rollbackToSafety(apiRoot: string) {
  console.log(chalk.red.bold("\n🛑 Reverting changes..."));
  try {
    execSync('git reset --hard HEAD', { cwd: apiRoot });
    execSync('git clean -fd', { cwd: apiRoot });
    console.log(chalk.green("✅ Project restored."));
  } catch (err) { }
}