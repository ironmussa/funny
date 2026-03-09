/**
 * Prompts and instruction builders for the api-acp agent proxy.
 */

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export function buildToolInstruction(tools: OpenAIToolDef[]): string {
  if (!tools.length) return '';

  const toolDescriptions = tools
    .map((t) => {
      const params = t.function.parameters
        ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}`
        : '';
      return `- ${t.function.name}: ${t.function.description ?? 'No description'}${params}`;
    })
    .join('\n');

  return `
You have access to the following tools. To call a tool, output a JSON array inside a fenced code block:

\`\`\`tool_calls
[{"id":"call_001","type":"function","function":{"name":"TOOL_NAME","arguments":{"param":"value"}}}]
\`\`\`

IMPORTANT: The "arguments" field must be a JSON OBJECT (not a string). Example:
✅ "arguments":{"path":"/src/index.ts","content":"hello"}
❌ "arguments":"{\\"path\\":\\"/src/index.ts\\"}"

Available tools:
${toolDescriptions}

CRITICAL RULES:
1. Output ONLY ONE tool_calls block per response, then STOP IMMEDIATELY.
2. Do NOT simulate, imagine, or fabricate tool results. You will receive REAL results in the next message.
3. Do NOT output any text after the tool_calls block. Your response ENDS at the closing block.
4. You may include a brief explanation BEFORE the tool_calls block.
5. If you don't need any tools, respond normally with text (no tool_calls block).
6. Each tool call MUST have a unique "id" like "call_001", "call_002", etc.`;
}
