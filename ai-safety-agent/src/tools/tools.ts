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
    }
];