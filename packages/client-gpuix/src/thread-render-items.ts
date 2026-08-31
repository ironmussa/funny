export interface ThreadRenderItem {
  id: string;
  key: string;
  kind: 'message' | 'tool-call';
}

export function createThreadRenderItems(
  messageIds: readonly string[],
  toolCallIdsByMessage: Readonly<Record<string, readonly string[] | undefined>>,
): ThreadRenderItem[] {
  const items: ThreadRenderItem[] = [];
  for (const messageId of messageIds) {
    items.push({ id: messageId, key: `message:${messageId}`, kind: 'message' });
    for (const toolCallId of toolCallIdsByMessage[messageId] ?? []) {
      items.push({ id: toolCallId, key: `tool-call:${toolCallId}`, kind: 'tool-call' });
    }
  }
  return items;
}
