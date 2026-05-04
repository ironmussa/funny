import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PromptInput } from '@/components/PromptInput';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { api } from '@/lib/api';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useActiveMessages } from '@/stores/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';

type ActiveThread = NonNullable<ReturnType<typeof useThreadStore.getState>['activeThread']>;

interface Props {
  activeThread: ActiveThread;
}

/**
 * The "idle thread" view shown after creating a backlog/idle thread but
 * before the agent has started: the project header plus a centered
 * PromptInput pre-loaded with any captured initialPrompt / initialImages.
 *
 * Extracted from ThreadView so the parent doesn't need to import PromptInput,
 * api, sonner, or settings-store.
 */
export function ThreadIdleStarter({ activeThread }: Props) {
  const { t } = useTranslation();
  const stableMessages = useActiveMessages();
  const [sending, setSending] = useState(false);

  const initialImages = (() => {
    const draftMsg = stableMessages?.find((m) => m.role === 'user');
    if (!draftMsg?.images) return undefined;
    try {
      const parsed =
        typeof draftMsg.images === 'string' ? JSON.parse(draftMsg.images) : draftMsg.images;
      return parsed?.length ? parsed : undefined;
    } catch {
      return undefined;
    }
  })();

  const handleSend = useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        effort?: string;
        fileReferences?: { path: string; type?: 'file' | 'folder' }[];
        symbolReferences?: {
          path: string;
          name: string;
          kind: string;
          line: number;
          endLine?: number;
        }[];
        baseBranch?: string;
      },
      images?: any[],
    ) => {
      setSending(true);
      useThreadStore
        .getState()
        .appendOptimisticMessage(
          activeThread.id,
          prompt,
          images,
          opts.model as any,
          opts.mode as any,
          opts.fileReferences,
        );
      const { allowedTools, disallowedTools } = deriveToolLists(
        useSettingsStore.getState().toolPermissions,
      );
      const result = await api.sendMessage(
        activeThread.id,
        prompt,
        {
          provider: opts.provider || undefined,
          model: opts.model || undefined,
          permissionMode: opts.mode || undefined,
          effort: opts.effort || undefined,
          allowedTools,
          disallowedTools,
          fileReferences: opts.fileReferences,
          symbolReferences: opts.symbolReferences,
          baseBranch: opts.baseBranch,
        },
        images,
      );
      if (result.isErr()) {
        const err = result.error;
        toast.error(
          err.type === 'INTERNAL'
            ? t('thread.sendFailed')
            : t('thread.sendFailedGeneric', { error: err.message }),
        );
      }
      setSending(false);
    },
    [activeThread.id, t],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ProjectHeader />
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-3xl">
          <PromptInput
            onSubmit={handleSend}
            loading={sending}
            isNewThread
            projectId={activeThread.projectId}
            threadId={activeThread.id}
            initialPrompt={activeThread.initialPrompt}
            initialImages={initialImages}
          />
        </div>
      </div>
    </div>
  );
}
