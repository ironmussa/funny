import type {
  GitHubPR,
  PRCommentKind,
  PRConversation,
  PRIssueComment,
  PRReactionContent,
  PRReactionSummary,
  PRReview,
  PRReviewThread,
  PRThreadComment,
} from '@funny/shared';
import {
  CheckCircle2,
  CircleDot,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  Reply,
  Send,
  Smile,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { baseMarkdownComponents, remarkPlugins } from '@/lib/markdown-components';
import { cn } from '@/lib/utils';

const log = createClientLogger('pinned-pr-card');

const LazyMarkdown = lazy(() =>
  import('react-markdown').then(({ default: ReactMarkdown }) => ({
    default: function Md({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={baseMarkdownComponents}>
          {content}
        </ReactMarkdown>
      );
    },
  })),
);

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const REACTION_EMOJI: Record<PRReactionContent, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
};

const REACTION_ORDER: PRReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
];

function reactionsTotal(r?: PRReactionSummary | null) {
  return r?.total ?? 0;
}

function reactionCounts(r?: PRReactionSummary | null): Array<{
  key: PRReactionContent;
  count: number;
}> {
  if (!r) return [];
  const entries: Array<{ key: PRReactionContent; count: number }> = [
    { key: '+1', count: r.plus1 },
    { key: '-1', count: r.minus1 },
    { key: 'laugh', count: r.laugh },
    { key: 'hooray', count: r.hooray },
    { key: 'confused', count: r.confused },
    { key: 'heart', count: r.heart },
    { key: 'rocket', count: r.rocket },
    { key: 'eyes', count: r.eyes },
  ];
  return entries.filter((e) => e.count > 0);
}

interface PinnedPRCardProps {
  pr: GitHubPR;
  projectId: string;
  currentUserLogin?: string;
}

// ── Reaction bar ──

function ReactionBar({
  reactions,
  onReact,
  disabled,
  testIdBase,
}: {
  reactions: PRReactionSummary | undefined;
  onReact: (c: PRReactionContent) => void;
  disabled?: boolean;
  testIdBase: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const counts = reactionCounts(reactions);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {counts.map(({ key, count }) => (
        <Button
          key={key}
          variant="outline"
          size="xs"
          className="h-5 gap-1 px-1.5 text-[10px]"
          disabled={disabled}
          onClick={() => onReact(key)}
          data-testid={`${testIdBase}-reaction-${key}`}
        >
          <span>{REACTION_EMOJI[key]}</span>
          <span>{count}</span>
        </Button>
      ))}
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              disabled={disabled}
              onClick={() => setPickerOpen((v) => !v)}
              data-testid={`${testIdBase}-react-open`}
            >
              <Smile className="icon-xs" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Add reaction</TooltipContent>
        </Tooltip>
        {pickerOpen && (
          <div
            className="absolute left-0 top-full z-10 mt-1 flex gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
            data-testid={`${testIdBase}-react-picker`}
          >
            {REACTION_ORDER.map((k) => (
              <button
                key={k}
                className="rounded px-1 text-sm hover:bg-accent"
                onClick={() => {
                  onReact(k);
                  setPickerOpen(false);
                }}
                data-testid={`${testIdBase}-react-${k}`}
              >
                {REACTION_EMOJI[k]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Comment body renderer ──

function MarkdownBody({ body }: { body: string }) {
  const trimmed = (body ?? '').trim();
  if (!trimmed) {
    return <span className="italic text-muted-foreground">(empty)</span>;
  }
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <Suspense fallback={<pre className="whitespace-pre-wrap text-xs">{trimmed}</pre>}>
        <LazyMarkdown content={trimmed} />
      </Suspense>
    </div>
  );
}

// ── Edit form ──

function EditForm({
  initial,
  onCancel,
  onSave,
  saving,
  testId,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => void;
  saving: boolean;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        className="w-full rounded-md border border-border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid={`${testId}-textarea`}
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onCancel} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => onSave(value)}
          disabled={saving || value.trim() === initial.trim() || !value.trim()}
          data-testid={`${testId}-save`}
        >
          {saving ? <Loader2 className="icon-xs animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}

// ── Main component ──

export function PinnedPRCard({ pr, projectId, currentUserLogin }: PinnedPRCardProps) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<PRReviewThread[]>([]);
  const [conversation, setConversation] = useState<PRConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [replyForThread, setReplyForThread] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [replyingThread, setReplyingThread] = useState(false);

  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null); // `${kind}-${id}`
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resolvingNodeId, setResolvingNodeId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [threadsRes, convRes] = await Promise.all([
      api.githubPRThreads(projectId, pr.number),
      api.githubPRConversation(projectId, pr.number),
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
    setLoading(false);
  }, [projectId, pr.number]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ── Actions ──

  const handleNewComment = async () => {
    const body = newComment.trim();
    if (!body) return;
    setPosting(true);
    const res = await api.githubPRCommentCreate(projectId, pr.number, body);
    if (res.isOk()) {
      setConversation((prev) =>
        prev
          ? { ...prev, comments: [...prev.comments, res.value] }
          : { comments: [res.value], reviews: [] },
      );
      setNewComment('');
    } else {
      log.error('pr_comment_create_failed', { error: res.error.message, prNumber: pr.number });
      setError(res.error.message);
    }
    setPosting(false);
  };

  const handleReply = async (thread: PRReviewThread) => {
    const body = replyBody.trim();
    if (!body) return;
    const rootId = thread.comments[0]?.id;
    if (!rootId) return;
    setReplyingThread(true);
    const res = await api.githubPRReviewReply(projectId, pr.number, rootId, body);
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

  // ── Render helpers ──

  const isOwnComment = (author: string) =>
    !!currentUserLogin && author.toLowerCase() === currentUserLogin.toLowerCase();

  const renderThreadComment = (thread: PRReviewThread, c: PRThreadComment, isRoot: boolean) => {
    const editKey = `review-${c.id}`;
    const isEditing = editingId === editKey;
    return (
      <div key={c.id} className={cn('flex flex-col gap-1', !isRoot && 'pl-3')}>
        <div className="flex items-center gap-1.5 text-xs">
          <AuthorBadge name={c.author} avatarUrl={c.author_avatar_url} size="xs" />
          <span className="text-muted-foreground">{timeAgo(c.created_at)}</span>
          {c.author_association && c.author_association !== 'NONE' && (
            <Badge variant="outline" className="h-3.5 px-1 text-[9px]">
              {c.author_association}
            </Badge>
          )}
          <div className="flex-1" />
          {isOwnComment(c.author) && !isEditing && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setEditingId(editKey)}
                    data-testid={`pinned-pr-review-edit-${c.id}`}
                  >
                    <Pencil className="icon-xs" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={deletingId === editKey}
                    onClick={() => handleDelete('review', c.id, editKey)}
                    data-testid={`pinned-pr-review-delete-${c.id}`}
                  >
                    {deletingId === editKey ? (
                      <Loader2 className="icon-xs animate-spin" />
                    ) : (
                      <Trash2 className="icon-xs" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Delete</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {isEditing ? (
          <EditForm
            initial={c.body}
            saving={savingEditId === editKey}
            onCancel={() => setEditingId(null)}
            onSave={(body) => handleEditSave('review', c.id, body, editKey)}
            testId={`pinned-pr-review-edit-form-${c.id}`}
          />
        ) : (
          <MarkdownBody body={c.body} />
        )}
      </div>
    );
  };

  const renderIssueComment = (c: PRIssueComment) => {
    const editKey = `issue-${c.id}`;
    const isEditing = editingId === editKey;
    return (
      <div
        key={c.id}
        className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2"
        data-testid={`pinned-pr-comment-${c.id}`}
      >
        <div className="flex items-center gap-1.5 text-xs">
          <AuthorBadge name={c.author} avatarUrl={c.author_avatar_url} size="xs" />
          <span className="text-muted-foreground">{timeAgo(c.created_at)}</span>
          {c.author_association && c.author_association !== 'NONE' && (
            <Badge variant="outline" className="h-3.5 px-1 text-[9px]">
              {c.author_association}
            </Badge>
          )}
          <div className="flex-1" />
          {isOwnComment(c.author) && !isEditing && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setEditingId(editKey)}
                    data-testid={`pinned-pr-comment-edit-${c.id}`}
                  >
                    <Pencil className="icon-xs" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={deletingId === editKey}
                    onClick={() => handleDelete('issue', c.id, editKey)}
                    data-testid={`pinned-pr-comment-delete-${c.id}`}
                  >
                    {deletingId === editKey ? (
                      <Loader2 className="icon-xs animate-spin" />
                    ) : (
                      <Trash2 className="icon-xs" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Delete</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {isEditing ? (
          <EditForm
            initial={c.body}
            saving={savingEditId === editKey}
            onCancel={() => setEditingId(null)}
            onSave={(body) => handleEditSave('issue', c.id, body, editKey)}
            testId={`pinned-pr-comment-edit-form-${c.id}`}
          />
        ) : (
          <MarkdownBody body={c.body} />
        )}
        <ReactionBar
          reactions={c.reactions}
          onReact={(k) => handleReact('issue', c.id, k)}
          testIdBase={`pinned-pr-comment-${c.id}`}
        />
      </div>
    );
  };

  const renderReview = (rv: PRReview) => {
    const stateBadge: Record<PRReview['state'], { label: string; cls: string }> = {
      APPROVED: { label: 'Approved', cls: 'text-green-600 border-green-600/40' },
      CHANGES_REQUESTED: { label: 'Changes requested', cls: 'text-red-600 border-red-600/40' },
      COMMENTED: { label: 'Commented', cls: 'text-muted-foreground' },
      DISMISSED: { label: 'Dismissed', cls: 'text-muted-foreground' },
      PENDING: { label: 'Pending', cls: 'text-muted-foreground' },
    };
    const s = stateBadge[rv.state];
    return (
      <div
        key={rv.id}
        className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2"
        data-testid={`pinned-pr-review-${rv.id}`}
      >
        <div className="flex items-center gap-1.5 text-xs">
          <AuthorBadge name={rv.author} avatarUrl={rv.author_avatar_url} size="xs" />
          <Badge variant="outline" className={cn('h-3.5 px-1 text-[9px]', s.cls)}>
            {s.label}
          </Badge>
          <span className="text-muted-foreground">{timeAgo(rv.submitted_at)}</span>
        </div>
        {rv.body && <MarkdownBody body={rv.body} />}
      </div>
    );
  };

  // Group threads by file
  const threadsByFile = useMemo(() => {
    const map = new Map<string, PRReviewThread[]>();
    for (const th of threads) {
      const arr = map.get(th.path) ?? [];
      arr.push(th);
      map.set(th.path, arr);
    }
    return map;
  }, [threads]);

  const unresolvedCount = threads.filter((t) => !t.is_resolved).length;

  return (
    <div
      className="flex flex-col gap-3 border-b border-sidebar-border bg-sidebar-accent/10 p-3"
      data-testid={`pinned-pr-card-${pr.number}`}
    >
      {/* Header with PR body */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <a
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 font-mono text-xs text-muted-foreground hover:underline"
                data-testid={`pinned-pr-link-${pr.number}`}
              >
                #{pr.number}
              </a>
              <span className="text-sm font-semibold">{pr.title}</span>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                asChild
                className="shrink-0 text-muted-foreground"
                data-testid={`pinned-pr-open-github-${pr.number}`}
              >
                <a href={pr.html_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="icon-xs" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Open on GitHub</TooltipContent>
          </Tooltip>
        </div>
        {pr.body && (
          <div className="rounded-md border border-border bg-background p-2">
            <MarkdownBody body={pr.body} />
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="icon-xs animate-spin" />
          {t('review.pullRequests.loadingConversation', 'Loading conversation…')}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Review threads */}
      {!loading && threads.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="size-3" />
            <span>
              {t('review.pullRequests.reviewThreads', 'Review threads')} ({threads.length}
              {unresolvedCount > 0 ? ` · ${unresolvedCount} unresolved` : ''})
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {Array.from(threadsByFile.entries()).map(([filePath, fileThreads]) => (
              <div key={filePath} className="flex flex-col gap-1.5">
                <div
                  className="truncate font-mono text-[10px] text-muted-foreground"
                  title={filePath}
                >
                  {filePath}
                </div>
                {fileThreads.map((th) => {
                  const resolving = resolvingNodeId === th.node_id;
                  return (
                    <div
                      key={th.id}
                      className={cn(
                        'flex flex-col gap-2 rounded-md border p-2',
                        th.is_resolved
                          ? 'border-border/40 bg-background/50 opacity-70'
                          : 'border-border bg-background',
                      )}
                      data-testid={`pinned-pr-thread-${th.id}`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        {th.is_resolved ? (
                          <CheckCircle2 className="size-3 text-green-600" />
                        ) : (
                          <CircleDot className="size-3" />
                        )}
                        <span>
                          Line {th.line ?? th.original_line ?? '?'}
                          {th.is_outdated ? ' (outdated)' : ''}
                        </span>
                        <div className="flex-1" />
                        {th.node_id && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            disabled={resolving}
                            onClick={() => handleResolve(th)}
                            data-testid={`pinned-pr-thread-resolve-${th.id}`}
                          >
                            {resolving ? (
                              <Loader2 className="icon-xs animate-spin" />
                            ) : th.is_resolved ? (
                              'Unresolve'
                            ) : (
                              'Resolve'
                            )}
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        {th.comments.map((c, idx) => renderThreadComment(th, c, idx === 0))}
                      </div>
                      {replyForThread === th.id ? (
                        <div className="flex flex-col gap-1.5 pl-3">
                          <textarea
                            className="w-full rounded-md border border-border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                            rows={2}
                            value={replyBody}
                            onChange={(e) => setReplyBody(e.target.value)}
                            placeholder="Reply…"
                            data-testid={`pinned-pr-thread-reply-textarea-${th.id}`}
                          />
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                setReplyForThread(null);
                                setReplyBody('');
                              }}
                              data-testid={`pinned-pr-thread-reply-cancel-${th.id}`}
                            >
                              <X className="icon-xs" />
                            </Button>
                            <Button
                              size="xs"
                              disabled={!replyBody.trim() || replyingThread}
                              onClick={() => handleReply(th)}
                              data-testid={`pinned-pr-thread-reply-send-${th.id}`}
                            >
                              {replyingThread ? (
                                <Loader2 className="icon-xs animate-spin" />
                              ) : (
                                <Send className="icon-xs" />
                              )}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="pl-3">
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 gap-1 px-1.5 text-[10px]"
                            onClick={() => {
                              setReplyForThread(th.id);
                              setReplyBody('');
                            }}
                            data-testid={`pinned-pr-thread-reply-open-${th.id}`}
                          >
                            <Reply className="icon-xs" />
                            Reply
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviews */}
      {!loading && conversation && conversation.reviews.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <ThumbsUp className="size-3" />
            <span>
              {t('review.pullRequests.reviews', 'Reviews')} ({conversation.reviews.length})
            </span>
          </div>
          <div className="flex flex-col gap-2">{conversation.reviews.map(renderReview)}</div>
        </div>
      )}

      {/* Conversation comments */}
      {!loading && conversation && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="size-3" />
            <span>
              {t('review.pullRequests.conversation', 'Conversation')} (
              {conversation.comments.length})
            </span>
          </div>
          <div className="flex flex-col gap-2">{conversation.comments.map(renderIssueComment)}</div>

          {/* New comment */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2">
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              rows={3}
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={t('review.pullRequests.newCommentPlaceholder', 'Leave a comment…')}
              data-testid="pinned-pr-new-comment-textarea"
            />
            <div className="flex justify-end">
              <Button
                size="xs"
                disabled={!newComment.trim() || posting}
                onClick={handleNewComment}
                data-testid="pinned-pr-new-comment-send"
              >
                {posting ? (
                  <Loader2 className="icon-xs animate-spin" />
                ) : (
                  <>
                    <Send className="icon-xs" />
                    {t('common.send', 'Send')}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!loading && threads.length === 0 && conversation && conversation.comments.length === 0 && (
        <div className="text-xs text-muted-foreground">
          {t('review.pullRequests.noConversation', 'No conversation yet.')}
        </div>
      )}
    </div>
  );
}

function bumpReaction(r: PRReactionSummary, content: PRReactionContent): PRReactionSummary {
  const next = { ...r, total: reactionsTotal(r) + 1 };
  switch (content) {
    case '+1':
      next.plus1 += 1;
      break;
    case '-1':
      next.minus1 += 1;
      break;
    case 'laugh':
      next.laugh += 1;
      break;
    case 'hooray':
      next.hooray += 1;
      break;
    case 'confused':
      next.confused += 1;
      break;
    case 'heart':
      next.heart += 1;
      break;
    case 'rocket':
      next.rocket += 1;
      break;
    case 'eyes':
      next.eyes += 1;
      break;
  }
  return next;
}
