import type { EnrichedGitHubIssue, PRIssueComment } from '@funny/shared';
import { CircleCheck, CircleDot, ExternalLink, MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { IssueBadges } from '@/components/IssueBadges';
import { MarkdownBody } from '@/components/MarkdownBody';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { timeAgo } from '@/lib/thread-utils';

const log = createClientLogger('issue-detail-dialog');

interface IssueDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  issue: EnrichedGitHubIssue;
  /** Start a thread from this issue; hidden when the issue already has a branch. */
  onCreateThread?: (issue: EnrichedGitHubIssue) => void;
}

type CommentsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; comments: PRIssueComment[] };

const NO_COMMENTS: CommentsState = { status: 'ready', comments: [] };
const LOADING_COMMENTS: CommentsState = { status: 'loading' };

/**
 * The issue's comments while the dialog is open. They are derived during
 * render: an issue without comments needs no request, and a response only
 * counts for the issue it was fetched for.
 */
function useIssueComments(
  open: boolean,
  projectId: string,
  issueNumber: number,
  commentCount: number,
): CommentsState {
  const requestKey = `${projectId}#${issueNumber}#${commentCount}`;
  const [fetched, setFetched] = useState<{ key: string; state: CommentsState } | null>(null);
  // Each opening starts from the loading state, as the dialog refetches.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setFetched(null);
  }
  const comments: CommentsState =
    commentCount === 0
      ? NO_COMMENTS
      : fetched?.key === requestKey
        ? fetched.state
        : LOADING_COMMENTS;

  useEffect(() => {
    if (!open || commentCount === 0) return;
    let cancelled = false;
    const key = `${projectId}#${issueNumber}#${commentCount}`;
    api.githubIssueComments(projectId, issueNumber).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setFetched({ key, state: { status: 'ready', comments: result.value.comments } });
      } else {
        log.error('failed to load issue comments', {
          projectId,
          issueNumber,
          error: result.error.message,
        });
        setFetched({ key, state: { status: 'error', message: result.error.message } });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, issueNumber, commentCount]);

  return comments;
}

/** Issue detail popup: description and comment thread, like the PR detail dialog. */
export function IssueDetailDialog({
  open,
  onOpenChange,
  projectId,
  issue,
  onCreateThread,
}: IssueDetailDialogProps) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const comments = useIssueComments(open, projectId, issue.number, issue.comments);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        flush
        className="flex h-[85vh] max-w-3xl flex-col"
        data-testid="issue-detail-dialog"
      >
        <div className="border-border flex shrink-0 items-start gap-2 border-b px-4 py-3">
          {issue.state === 'open' ? (
            <CircleDot className="icon-base text-status-success mt-1 shrink-0" />
          ) : (
            <CircleCheck className="icon-base text-status-violet mt-1 shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogTitle size="sm" className="leading-snug" data-testid="issue-detail-title">
              {issue.title}{' '}
              <span className="text-muted-foreground font-normal">#{issue.number}</span>
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                <Badge size="xs" variant="outline">
                  {issue.state === 'open' ? t('issues.open', 'Open') : t('issues.closed', 'Closed')}
                </Badge>
                {issue.user && (
                  <AuthorBadge
                    name={issue.user.login}
                    avatarUrl={issue.user.avatar_url}
                    size="xs"
                  />
                )}
                <span>{timeAgo(issue.created_at, t, now)}</span>
                <IssueBadges issue={issue} />
              </div>
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onCreateThread && !issue.linkedBranch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="muted"
                    size="icon-xs"
                    onClick={() => {
                      onCreateThread(issue);
                      onOpenChange(false);
                    }}
                    data-testid="issue-detail-create-thread"
                  >
                    <Plus className="icon-xs" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('issues.createThread', 'Create thread')}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="muted"
                  size="icon-xs"
                  asChild
                  data-testid="issue-detail-open-github"
                >
                  <a
                    href={issue.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('issues.viewOnGithub', 'View on GitHub')}
                  >
                    <ExternalLink className="icon-xs" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('issues.viewOnGithub', 'View on GitHub')}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="muted"
              size="icon-xs"
              onClick={() => onOpenChange(false)}
              data-testid="issue-detail-close"
            >
              <X className="icon-xs" />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-4">
            <div
              className="border-border bg-background rounded-md border p-3"
              data-testid="issue-detail-body"
            >
              <MarkdownBody body={issue.body} />
            </div>
            <IssueComments state={comments} now={now} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function IssueComments({ state, now }: { state: CommentsState; now: number }) {
  const { t } = useTranslation();
  if (state.status === 'loading') {
    return (
      <LoadingState
        testId="issue-detail-comments-loading"
        label={t('issues.loadingComments', 'Loading comments…')}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <p className="text-muted-foreground text-xs" data-testid="issue-detail-comments-error">
        {t('issues.commentsError', 'Failed to load comments')}: {state.message}
      </p>
    );
  }
  if (state.comments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="issue-detail-comments">
      <div className="text-muted-foreground flex items-center gap-1 text-xs">
        <MessageSquare className="icon-xs" />
        {state.comments.length}
      </div>
      {state.comments.map((c) => (
        <div
          key={c.id}
          className="border-border bg-background flex flex-col gap-1.5 rounded-md border p-2"
          data-testid={`issue-detail-comment-${c.id}`}
        >
          <div className="flex items-center gap-1.5 text-xs">
            <AuthorBadge name={c.author} avatarUrl={c.author_avatar_url} size="xs" />
            <span className="text-muted-foreground">{timeAgo(c.created_at, t, now)}</span>
            {c.author_association && c.author_association !== 'NONE' && (
              <Badge size="xs" variant="outline">
                {c.author_association}
              </Badge>
            )}
          </div>
          <MarkdownBody body={c.body} />
        </div>
      ))}
    </div>
  );
}
