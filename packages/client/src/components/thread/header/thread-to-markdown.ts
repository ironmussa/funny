import type { Message, ToolCall } from '@funny/shared';

type MessageWithToolCalls = Message & { toolCalls?: ToolCall[] };

/** True for a string value. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Serialize the active thread's messages (and optionally tool calls) into
 * markdown for clipboard export. Used by the "Copy text" / "Copy with tool
 * calls" entries in MoreActionsMenu.
 */
export function threadToMarkdown(
  messages: MessageWithToolCalls[],
  includeToolCalls: boolean,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    if (msg.content?.trim()) {
      lines.push(`## ${role}\n\n${msg.content.trim()}\n`);
    }
    if (includeToolCalls && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        let inputStr = '';
        try {
          const parsed = isString(tc.input) ? JSON.parse(tc.input) : tc.input;
          inputStr = JSON.stringify(parsed, null, 2);
        } catch {
          inputStr = String(tc.input);
        }
        lines.push(`### Tool: ${tc.name}\n\n\`\`\`json\n${inputStr}\n\`\`\`\n`);
        if (tc.output) {
          lines.push(`**Output:**\n\n\`\`\`\n${tc.output}\n\`\`\`\n`);
        }
      }
    }
  }
  return lines.join('\n');
}
