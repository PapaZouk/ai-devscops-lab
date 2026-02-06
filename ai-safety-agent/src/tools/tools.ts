import OpenAI from "openai";

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string'
                    }
                },
                required: ['path']
            }
        }
    },
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
    {
        type: 'function',
        function: {
            name: 'propose_fix',
            description: 'Request audit.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string'
                    },
                    code: {
                        type: 'string'
                    }
                },
                required: ['path', 'code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'api_directory_helper',
            description: 'Lookup the verified project map to find services, repositories, and test files.',
            parameters: {
                type: 'object',
                properties: {
                    moduleName: {
                        type: 'string',
                        description: 'e.g., "auth", "products"'
                    }
                },
                required: ['moduleName']
            }
        }
    },
    {
        type: "function",
        function: {
            name: 'run_command',
            description: 'Execute a shell command in the project root. Use this to install missing dependencies identified during validation.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The full command to run (e.g., "npm install bcrypt")'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: "function",
        function: {
            name: "checkpoint_manager",
            description: "Saves or loads a 'Golden Version of code. Use this to persist an APPROVED fix before running tests, or to RECOVER a stable version if a subsequent modification fails.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["save", "load"],
                        description: "Whether to save the current code state or load the last saved checkpoint."
                    },
                    path: {
                        type: "string",
                        description: "The path of the file being managed (e.g., src/services/authService.ts)."
                    },
                    content: {
                        type: "string",
                        description: "The full source code content to save. (Required only for 'save' action)."
                    }
                },
                required: ["action", "path"]
            }
        }
    }
];