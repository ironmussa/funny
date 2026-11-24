import type { GitHubPR, PRReviewThread } from '@funny/shared';
import { Loader2, MessageSquare, Send, ThumbsUp } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { MarkdownBody } from '@/components/MarkdownBody';
import { PRCardSummary } from '@/components/pinned-pr-card/PRCardSummary';
import { IssueCommentCard, ReviewCard } from '@/components/pinned-pr-card/PRComments';
import { ReviewThreadCard } from '@/components/pinned-pr-card/ReviewThreadCard';
import {
  usePRCommentActions,
  usePRThreadActions,
} from '@/components/pinned-pr-card/use-pr-comment-actions';
import {
  useNewPRComment,
  usePRConversation,
  usePRMerge,
} from '@/components/pinned-pr-card/use-pr-conversation';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';

interface PinnedPRCardProps {
  pr: GitHubPR;
  projectId: string;
  currentUserLogin?: string;
  /** Called after a successful merge so the parent can refresh the PR list. */
  onMerged?: (prNumber: number) => void;
  onCreateThreadForBranch?: (branch: string) => void;
  /**
   * Hide the title / meta / actions line, for a host that already shows them
   * (the PR detail dialog's header). The description and the conversation stay.
   */
  hideSummary?: boolean;
}

// ── Main component ──

export function PinnedPRCard({
  pr,
  projectId,
  currentUserLogin,
  onMerged,
  onCreateThreadForBranch,
  hideSummary = false,
}: PinnedPRCardProps) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const { threads, setThreads, conversation, setConversation, loading, error, setError } =
    usePRConversation(projectId, pr.number);
  const { merging, merged, handleMerge } = usePRMerge({
    projectId,
    prNumber: pr.number,
    onMerged,
    setError,
  });
  const threadActions = usePRThreadActions({
    projectId,
    prNumber: pr.number,
    setThreads,
    setError,
  });
  const { newComment, setNewComment, posting, handleNewComment } = useNewPRComment({
    projectId,
    prNumber: pr.number,
    setConversation,
    setError,
  });
  const commentActions = usePRCommentActions({
    projectId,
    setConversation,
    setThreads,
    setError,
  });

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

  const isMerged = merged || !!pr.merged_at;
  const canMerge = pr.state === 'open' && !pr.draft && !isMerged;

  return (
    <div
      className="border-sidebar-border bg-sidebar-accent/10 flex flex-col gap-3 border-b p-3"
      data-testid={`pinned-pr-card-${pr.number}`}
    >
      {/* Header with PR body */}
      <div className="flex flex-col gap-2">
        {!hideSummary && (
          <PRCardSummary
            pr={pr}
            now={now}
            isMerged={isMerged}
            canMerge={canMerge}
            merging={merging}
            handleMerge={handleMerge}
            onCreateThreadForBranch={onCreateThreadForBranch}
          />
        )}
        {pr.body && (
          <div className="border-border bg-background rounded-md border p-2">
            <MarkdownBody body={pr.body} />
          </div>
        )}
      </div>

      {loading && (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2 className="icon-xs animate-spin" />
          {t('review.pullRequests.loadingConversation', 'Loading conversation…')}
        </div>
      )}

      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs">
          {error}
        </div>
      )}

      {/* Conversation comments (bots post their summaries here, right under the description) */}
      {!loading && conversation && conversation.comments.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground text-2xs flex items-center gap-1.5 font-medium tracking-wide uppercase">
            <MessageSquare className="size-3" />
            <span>
              {t('review.pullRequests.conversation', 'Conversation')} (
              {conversation.comments.length})
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {conversation.comments.map((c) => (
              <IssueCommentCard
                key={c.id}
                c={c}
                now={now}
                currentUserLogin={currentUserLogin}
                actions={commentActions}
              />
            ))}
          </div>
        </div>
      )}

      {/* Review threads */}
      {!loading && threads.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground text-2xs flex items-center gap-1.5 font-medium tracking-wide uppercase">
            <MessageSquare className="size-3" />
            <span>
              {t('review.pullRequests.reviewThreads', 'Review threads')} ({threads.length}
              {unresolvedCount > 0 ? ` · ${unresolvedCount} unresolved` : ''})
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {Array.from(threadsByFile.entries()).map(([filePath, fileThreads]) => (
              <div key={filePath} className="flex flex-col gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-muted-foreground text-2xs truncate font-mono">
                      {filePath}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent variant="mono">{filePath}</TooltipContent>
                </Tooltip>
                {fileThreads.map((th) => (
                  <ReviewThreadCard
                    key={th.id}
                    th={th}
                    now={now}
                    currentUserLogin={currentUserLogin}
                    commentActions={commentActions}
                    threadActions={threadActions}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviews */}
      {!loading && conversation && conversation.reviews.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground text-2xs flex items-center gap-1.5 font-medium tracking-wide uppercase">
            <ThumbsUp className="size-3" />
            <span>
              {t('review.pullRequests.reviews', 'Reviews')} ({conversation.reviews.length})
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {conversation.reviews.map((rv) => (
              <ReviewCard key={rv.id} rv={rv} now={now} />
            ))}
          </div>
        </div>
      )}

      {/* New comment */}
      {!loading && conversation && (
        <div className="flex flex-col gap-2">
          <div className="border-border bg-background flex flex-col gap-1.5 rounded-md border p-2">
            <textarea
              className="border-border bg-background focus:ring-ring w-full rounded-md border p-2 text-xs focus:ring-1 focus:outline-hidden"
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
        <div className="text-muted-foreground text-xs">
          {t('review.pullRequests.noConversation', 'No conversation yet.')}
        </div>
      )}
    </div>
  );
}
