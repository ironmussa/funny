import { addReferencedEntries, parseReferencedFiles } from '@funny/shared/attachments';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AvailableMcpServers } from '@/components/AvailableMcpServers';
import { PromptInput } from '@/components/PromptInput';
import { FileChip } from '@/components/ui/chip';
import { useProjectById } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import { buildWorkflowRunBody, parseWorkflowInvocation } from '@/lib/workflow-invocation';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadMessages, type ThreadCore } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

interface Props {
  activeThread: ThreadCore;
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
  const stableMessages = useThreadMessages();
  const [sending, setSending] = useState(false);
  const projectPath = useProjectById(activeThread.projectId)?.path;

  // The stored prompt carries the backlog thread's attachments as a leading
  // `<referenced-files>` manifest. The editor gets only the text; the
  // manifest is shown as chips and put back on send, where the runtime
  // reads the files.
  const stored = useMemo(
    () => parseReferencedFiles(activeThread.initialPrompt ?? ''),
    [activeThread.initialPrompt],
  );

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
        stagedUploads?: string[];
        baseBranch?: string;
      },
      images?: any[],
    ) => {
      const workflowParse = parseWorkflowInvocation(prompt);
      if (!workflowParse.ok) {
        toast.error(workflowParse.error);
        return false;
      }
      const invocation = workflowParse.invocation;
      if (invocation) {
        setSending(true);
        return (async () => {
          const result = await api.runWorkflow(invocation.workflowName, {
            threadId: activeThread.id,
            ...buildWorkflowRunBody(invocation, {
              fileReferences: opts.fileReferences,
              symbolReferences: opts.symbolReferences,
            }),
          });
          if (result.isErr()) {
            toast.error(result.error.message);
            return false;
          }
          toast.success(t('workflows.started', { defaultValue: 'Workflow started' }));
          return true;
        })().finally(() => setSending(false));
      }

      const fullPrompt = addReferencedEntries(prompt, stored.entries);
      setSending(true);
      return (async () => {
        useThreadStore
          .getState()
          .appendOptimisticMessage(
            activeThread.id,
            fullPrompt,
            images,
            opts.model as any,
            opts.mode as any,
            opts.fileReferences,
            opts.effort as any,
          );
        const { allowedTools, disallowedTools } = deriveToolLists(
          useSettingsStore.getState().toolPermissions,
        );
        const result = await api.sendMessage(
          activeThread.id,
          fullPrompt,
          {
            provider: opts.provider || undefined,
            model: opts.model || undefined,
            permissionMode: opts.mode || undefined,
            effort: opts.effort || undefined,
            allowedTools,
            disallowedTools,
            fileReferences: opts.fileReferences,
            symbolReferences: opts.symbolReferences,
            stagedUploads: opts.stagedUploads,
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
        } else if (result.value.handledLocally === 'shell_escape') {
          useThreadStore.getState().rollbackOptimisticMessage(activeThread.id);
        }
        return true;
      })().finally(() => setSending(false));
    },
    [activeThread.id, stored.entries, t],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-3xl">
          {stored.entries.length > 0 && (
            <div data-testid="idle-thread-attachments" className="mb-2 flex flex-wrap gap-1.5">
              {stored.entries.map((entry) => (
                <FileChip
                  key={entry.path}
                  name={entry.path.split('/').pop() ?? entry.path}
                  type={entry.type}
                  title={entry.path}
                  data-testid={`idle-thread-attachment-${entry.path}`}
                />
              ))}
            </div>
          )}
          <PromptInput
            onSubmit={handleSend}
            loading={sending}
            isNewThread
            projectId={activeThread.projectId}
            initialPrompt={stored.entries.length > 0 ? stored.body : activeThread.initialPrompt}
            initialImages={initialImages}
          />
          <AvailableMcpServers
            projectPath={projectPath}
            projectId={activeThread.projectId}
            provider={activeThread.provider}
          />
        </div>
      </div>
    </div>
  );
}
