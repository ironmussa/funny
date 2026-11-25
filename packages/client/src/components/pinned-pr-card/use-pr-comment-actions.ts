import type {
  PRCommentKind,
  PRConversation,
  PRReactionContent,
  PRReviewThread,
} from '@funny/shared';
import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';

import { bumpReaction } from './pr-card-helpers';

const log = createClientLogger('pinned-pr-card');

interface ConversationSetters {
  projectId: string;
  setConversation: Dispatch<SetStateAction<PRConversation | null>>;
  setThreads: Dispatch<SetStateAction<PRReviewThread[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/** Reacting to, editing and deleting comments (issue comments and review comments). */
export function usePRCommentActions({
  projectId,
  setConversation,
  setThreads,
  setError,
}: ConversationSetters) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null); // `${kind}-${id}`
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleReact = async (
    kind: PRCommentKind,
    commentId: number,
    content: PRReactionContent,
  ) => {
    const res = await api.githubPRReaction(projectId, kind, commentId, content);
    if (res.isOk()) {
      // Optimistically bump the count locally
      if (kind === 'issue') {
        setConversation((prev) =>
          prev
            ? {
                ...prev,
                comments: prev.comments.map((c) =>
                  c.id === commentId ? { ...c, reactions: bumpReaction(c.reactions, content) } : c,
                ),
              }
            : prev,
        );
      }
    } else {
      log.error('pr_reaction_failed', { error: res.error.message });
    }
  };

  const handleEditSave = async (
    kind: PRCommentKind,
    commentId: number,
    body: string,
    editKey: string,
  ) => {
    setSavingEditId(editKey);
    const res = await api.githubPRCommentEdit(projectId, kind, commentId, body);
    if (res.isOk()) {
      if (kind === 'issue') {
        setConversation((prev) =>
          prev
            ? {
                ...prev,
                comments: prev.comments.map((c) =>
                  c.id === commentId
                    ? {
                        ...c,
                        body: res.value.body,
                        updated_at: res.value.updated_at,
                        reactions: res.value.reactions,
                      }
                    : c,
                ),
              }
            : prev,
        );
      } else {
        setThreads((prev) =>
          prev.map((th) => ({
            ...th,
            comments: th.comments.map((c) =>
              c.id === commentId
                ? { ...c, body: res.value.body, updated_at: res.value.updated_at }
                : c,
            ),
          })),
        );
      }
      setEditingId(null);
    } else {
      log.error('pr_comment_edit_failed', { error: res.error.message });
      setError(res.error.message);
    }
    setSavingEditId(null);
  };

  const handleDelete = async (kind: PRCommentKind, commentId: number, key: string) => {
    if (!confirm(t('review.pullRequests.confirmDelete', 'Delete this comment?'))) return;
    setDeletingId(key);
    const res = await api.githubPRCommentDelete(projectId, kind, commentId);
    if (res.isOk()) {
      if (kind === 'issue') {
        setConversation((prev) =>
          prev ? { ...prev, comments: prev.comments.filter((c) => c.id !== commentId) } : prev,
        );
      } else {
        setThreads((prev) =>
          prev
            .map((th) => ({
              ...th,
              comments: th.comments.filter((c) => c.id !== commentId),
            }))
            .filter((th) => th.comments.length > 0),
        );
      }
    } else {
      log.error('pr_comment_delete_failed', { error: res.error.message });
      setError(res.error.message);
    }
    setDeletingId(null);
  };

  return {
    editingId,
    setEditingId,
    savingEditId,
    deletingId,
    handleReact,
    handleEditSave,
    handleDelete,
  };
}

export type PRCommentActions = ReturnType<typeof usePRCommentActions>;

/** Replying to and resolving review threads. */
export function usePRThreadActions({
  projectId,
  prNumber,
  setThreads,
  setError,
}: Omit<ConversationSetters, 'setConversation'> & { prNumber: number }) {
  const [replyForThread, setReplyForThread] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [replyingThread, setReplyingThread] = useState(false);
  const [resolvingNodeId, setResolvingNodeId] = useState<string | null>(null);

  const handleReply = async (thread: PRReviewThread) => {
    const body = replyBody.trim();
    if (!body) return;
    const rootId = thread.comments[0]?.id;
    if (!rootId) return;
    setReplyingThread(true);
    const res = await api.githubPRReviewReply(projectId, prNumber, rootId, body);
    if (res.isOk()) {
      setThreads((prev) =>
        prev.map((th) =>
          th.id === thread.id ? { ...th, comments: [...th.comments, res.value] } : th,
        ),
      );
      setReplyBody('');
      setReplyForThread(null);
    } else {
      log.error('pr_review_reply_failed', { error: res.error.message });
      setError(res.error.message);
    }
    setReplyingThread(false);
  };

  const handleResolve = async (thread: PRReviewThread) => {
    if (!thread.node_id) return;
    setResolvingNodeId(thread.node_id);
    const res = await api.githubPRThreadResolve(projectId, thread.node_id, !thread.is_resolved);
    if (res.isOk()) {
      setThreads((prev) =>
        prev.map((th) =>
          th.node_id === thread.node_id ? { ...th, is_resolved: res.value.is_resolved } : th,
        ),
      );
    } else {
      log.error('pr_thread_resolve_failed', { error: res.error.message });
      setError(res.error.message);
    }
    setResolvingNodeId(null);
  };

  return {
    replyForThread,
    setReplyForThread,
    replyBody,
    setReplyBody,
    replyingThread,
    resolvingNodeId,
    handleReply,
    handleResolve,
  };
}

export type PRThreadActions = ReturnType<typeof usePRThreadActions>;
