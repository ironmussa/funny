import { useTranslation } from 'react-i18next';

import { CopyButton } from '@/components/ui/copy-button';
import { api } from '@/lib/api';

import { threadToMarkdown } from './header/thread-to-markdown';

/** Messages from the most recent user prompt to the end of the thread. */
function latestTurn<M extends { role: string; content?: string | null }>(messages: M[]): M[] {
  const start = messages.findLastIndex((m) => m.role === 'user' && !!m.content?.trim());
  return start === -1 ? messages : messages.slice(start);
}

type CopyableMessage = Parameters<typeof threadToMarkdown>[0][number];

/**
 * Copies one prompt and its replies (no tool cards). Pass `messages` for a turn
 * already in memory; otherwise the latest turn of `threadId` is fetched. Reuses
 * the shared `CopyButton`, so the icon feedback matches every other copy action.
 */
export function CopyThreadButton({
  threadId,
  messages,
}: {
  threadId: string;
  messages?: CopyableMessage[];
}) {
  const { t } = useTranslation();

  const getMarkdown = async () => {
    if (messages) return threadToMarkdown(messages, false);
    // Omit messageLimit so the latest turn is complete even outside the rendered window.
    const result = await api.getThread(threadId);
    if (result.isErr()) throw new Error(result.error.message);
    return threadToMarkdown(latestTurn(result.value.messages), false);
  };

  return (
    <CopyButton
      value={getMarkdown}
      label={t('thread.copyLatestTurn', 'Copy latest prompt and response')}
      copiedLabel={t('thread.latestTurnCopied', 'Latest response copied')}
      data-testid="agent-result-copy-latest-turn"
      className="size-auto p-1 [&_svg]:size-3.5"
    />
  );
}
