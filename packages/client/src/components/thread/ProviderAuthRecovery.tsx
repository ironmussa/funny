import type { ThreadWithMessages } from '@funny/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';
import { Button } from '@/components/ui/button';
import { stripAnsi } from '@/lib/ansi-to-html';
import { useThreadStore } from '@/stores/thread-store';

/** Only inspect the current turn, never errors from an earlier conversation turn. */
export function findProviderAuthError(thread: ThreadWithMessages | undefined): string | undefined {
  if (!thread) return;
  const messages = thread.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') break;
    if (thread.lastUserMessage && message.timestamp < thread.lastUserMessage.timestamp) break;
    const error = message.toolCalls?.find((tool) => {
      if (tool.name !== 'ProviderError') return false;
      const text = stripAnsi(`${tool.input ?? ''}\n${tool.output ?? ''}`);
      return /OAuth session expired|Failed to authenticate|(?:access|refresh)[ _-]?token.{0,60}(?:expired|invalid|revoked)|authentication[_ ](?:required|error)|not (?:logged|signed) in/i.test(
        text,
      );
    });
    if (error) return error.id;
  }
}

export function ProviderAuthRecovery({ threadId }: { threadId: string }) {
  const errorId = useThreadStore((s) => findProviderAuthError(s.threadDataById[threadId]));
  const provider = useThreadStore((s) => s.threadDataById[threadId]?.provider);
  const projectId = useThreadStore((s) => s.threadDataById[threadId]?.projectId);
  if (!errorId || !provider || !projectId) return null;
  return (
    <RecoveryPrompt key={`${threadId}:${errorId}`} provider={provider} projectId={projectId} />
  );
}

function RecoveryPrompt({ provider, projectId }: { provider: string; projectId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="border-border space-y-2 rounded-lg border p-3 text-sm" role="status">
        <p>{t('thread.providerAuthExpired')}</p>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {t('thread.reconnectProvider')}
        </Button>
      </div>
      {open && (
        <ProviderSetupDialog
          provider={provider}
          label={provider}
          projectId={projectId}
          reauthenticate
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
