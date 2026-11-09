import type { QueuedMessage } from '@funny/shared';

/** Builds a preview row from the queue summary while the full queue is loading. */
export function buildPreviewQueue(
  threadId: string | null | undefined,
  queuedCount: number,
  queuedNextMessage: string | undefined,
): QueuedMessage[] {
  if (!threadId || queuedCount <= 0 || !queuedNextMessage) return [];
  return [
    {
      id: `preview-queued-message:${threadId}`,
      threadId,
      content: queuedNextMessage,
      sortOrder: 0,
      createdAt: '',
    } satisfies QueuedMessage,
  ];
}

/** The loaded queue when it matches the summary, else the preview row. */
export function pickRenderedQueue(
  loaded: QueuedMessage[],
  preview: QueuedMessage[],
): QueuedMessage[] {
  return loaded.length > 0 ? loaded : preview;
}
