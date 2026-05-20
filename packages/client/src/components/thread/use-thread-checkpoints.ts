/**
 * Thread-checkpoint actions: fork, rewind, fork-and-rewind.
 *
 * Extracted from use-thread-handlers so messaging concerns (send, follow-up,
 * approve, stop) stay in one hook and code/conversation rewind concerns
 * stay in another. The 3 handlers share the same `forkingMessageId`
 * in-flight guard (they're mutually exclusive — only one can run at a
 * time per thread).
 *
 * Scratch threads MUST be gated at the call-site (ThreadChatView) via
 * `canDoGitOps(thread)` — the API endpoints here all assume a project +
 * repo and the navigation paths point at `/projects/...`.
 */

import { useCallback, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import type { ThreadCore } from '@/stores/thread-context';
import { invalidateThreadData } from '@/stores/thread-machine-bridge';
import { invalidateSelectThread, useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('ThreadCheckpoints');

interface Refs {
  activeThreadRef: RefObject<ThreadCore | null>;
}

export interface UseThreadCheckpointsResult {
  /** messageId currently being forked/rewound, or null when idle. */
  forkingMessageId: string | null;
  handleFork: (messageId: string) => Promise<void>;
  handleRewind: (messageId: string) => Promise<void>;
  handleForkAndRewind: (messageId: string) => Promise<void>;
}

export function useThreadCheckpoints(refs: Refs): UseThreadCheckpointsResult {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

  const handleFork = useCallback(
    async (messageId: string) => {
      const thread = refs.activeThreadRef.current;
      if (!thread || forkingMessageId) return;
      setForkingMessageId(messageId);
      try {
        const result = await api.forkThread(thread.id, messageId);
        if (result.isErr()) {
          log.error('forkThread failed', {
            threadId: thread.id,
            messageId,
            error: result.error.message,
          });
          toast.error(t('thread.forkFailed', 'Failed to fork conversation'));
          return;
        }
        const newThread = result.value;
        useThreadStore.setState({ selectedThreadId: newThread.id });
        await useThreadStore.getState().loadThreadsForProject(thread.projectId);
        navigate(buildPath(`/projects/${thread.projectId}/threads/${newThread.id}`));
        toast.success(t('thread.forkSuccess', 'Forked conversation'));
      } finally {
        setForkingMessageId(null);
      }
    },
    [forkingMessageId, navigate, refs, t],
  );

  const handleRewind = useCallback(
    async (messageId: string) => {
      const thread = refs.activeThreadRef.current;
      if (!thread || forkingMessageId) return;
      setForkingMessageId(messageId);
      try {
        const result = await api.rewindCode(thread.id, messageId);
        if (result.isErr()) {
          log.error('rewindCode failed', {
            threadId: thread.id,
            messageId,
            error: result.error.message,
          });
          toast.error(
            result.error.type === 'INTERNAL'
              ? t('thread.rewindFailed', 'Failed to rewind code')
              : t('thread.rewindFailedGeneric', { error: result.error.message }),
          );
          return;
        }
        // Force-refresh the thread so the truncated transcript replaces the
        // current in-memory message list.
        invalidateThreadData(thread.id);
        invalidateSelectThread();
        await useThreadStore.getState().selectThread(thread.id);
        const filesChanged = result.value.rewind.filesChanged?.length ?? 0;
        toast.success(
          t('thread.rewindSuccess', {
            count: filesChanged,
            defaultValue_one: 'Rewound 1 file',
            defaultValue_other: 'Rewound {{count}} files',
            defaultValue: 'Code rewound',
          }),
        );
      } finally {
        setForkingMessageId(null);
      }
    },
    [forkingMessageId, refs, t],
  );

  const handleForkAndRewind = useCallback(
    async (messageId: string) => {
      const thread = refs.activeThreadRef.current;
      if (!thread || forkingMessageId) return;
      setForkingMessageId(messageId);
      try {
        const result = await api.forkAndRewind(thread.id, messageId);
        if (result.isErr()) {
          log.error('forkAndRewind failed', {
            threadId: thread.id,
            messageId,
            error: result.error.message,
          });
          toast.error(t('thread.forkAndRewindFailed', 'Failed to fork and rewind'));
          return;
        }
        const newThread = result.value.thread;
        useThreadStore.setState({ selectedThreadId: newThread.id });
        await useThreadStore.getState().loadThreadsForProject(thread.projectId);
        navigate(buildPath(`/projects/${thread.projectId}/threads/${newThread.id}`));
        toast.success(t('thread.forkAndRewindSuccess', 'Forked and rewound code'));
      } finally {
        setForkingMessageId(null);
      }
    },
    [forkingMessageId, navigate, refs, t],
  );

  return { forkingMessageId, handleFork, handleRewind, handleForkAndRewind };
}
