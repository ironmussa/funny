import type { PRConversation, PRReviewThread } from '@funny/shared';
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { whilePending } from '@/lib/while-pending';

const log = createClientLogger('pinned-pr-card');

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** A pull request's review threads and conversation, loaded on mount. */
export function usePRConversation(projectId: string, prNumber: number) {
  const [threads, setThreads] = useState<PRReviewThread[]>([]);
  const [conversation, setConversation] = useState<PRConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    return whilePending(setLoading, async () => {
      setError(null);
      const [threadsRes, convRes] = await Promise.all([
        api.githubPRThreads(projectId, prNumber),
        api.githubPRConversation(projectId, prNumber),
      ]);
      if (threadsRes.isOk()) setThreads(threadsRes.value.threads);
      if (convRes.isOk()) setConversation(convRes.value);
      if (threadsRes.isErr() || convRes.isErr()) {
        setError(
          threadsRes.isErr()
            ? threadsRes.error.message
            : convRes.isErr()
              ? convRes.error.message
              : 'Failed to load PR data',
        );
      }
    });
  }, [projectId, prNumber]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return { threads, setThreads, conversation, setConversation, loading, error, setError };
}

/** Merging the pull request with a chosen method. */
export function usePRMerge({
  projectId,
  prNumber,
  onMerged,
  setError,
}: {
  projectId: string;
  prNumber: number;
  onMerged: ((prNumber: number) => void) | undefined;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useTranslation();
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);

  const handleMerge = async (method: MergeMethod) => {
    setMerging(true);
    setError(null);
    const res = await api.githubPRMerge(projectId, prNumber, method);
    if (res.isOk() && res.value.merged) {
      setMerged(true);
      onMerged?.(prNumber);
    } else {
      const message = res.isErr()
        ? res.error.message
        : t('review.pullRequests.mergeFailed', 'Failed to merge pull request');
      log.error('pr_merge_failed', { error: message, prNumber, method });
      setError(message);
    }
    setMerging(false);
  };

  return { merging, merged, handleMerge };
}

/** The new-comment box: draft text, posting flag and the post action. */
export function useNewPRComment({
  projectId,
  prNumber,
  setConversation,
  setError,
}: {
  projectId: string;
  prNumber: number;
  setConversation: Dispatch<SetStateAction<PRConversation | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);

  const handleNewComment = async () => {
    const body = newComment.trim();
    if (!body) return;
    await whilePending(setPosting, async () => {
      const res = await api.githubPRCommentCreate(projectId, prNumber, body);
      if (res.isOk()) {
        setConversation((prev) =>
          prev
            ? { ...prev, comments: [...prev.comments, res.value] }
            : { comments: [res.value], reviews: [] },
        );
        setNewComment('');
      } else {
        log.error('pr_comment_create_failed', { error: res.error.message, prNumber });
        setError(res.error.message);
      }
    });
  };

  return { newComment, setNewComment, posting, handleNewComment };
}
