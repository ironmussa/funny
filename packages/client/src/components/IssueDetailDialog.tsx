import type { EnrichedGitHubIssue } from '@funny/shared';
import { CircleCheck, CircleDot, ExternalLink, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { IssueTimeline, type TimelineState } from '@/components/issue-detail/IssueTimeline';
import { IssueBadges } from '@/components/IssueBadges';
import { MarkdownBody } from '@/components/MarkdownBody';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { githubRepoBaseUrl } from '@/lib/github-issue-refs';
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

const LOADING_TIMELINE: TimelineState = { status: 'loading' };

/**
 * The issue's comments and events while the dialog is open. A response only
 * counts for the issue (and the version of it, `updated_at`) it was fetched for.
 */
function useIssueTimeline(
  open: boolean,
  projectId: string,
  issueNumber: number,
  updatedAt: string,
): TimelineState {
  const requestKey = `${projectId}#${issueNumber}#${updatedAt}`;
  const [fetched, setFetched] = useState<{ key: string; state: TimelineState } | null>(null);
  // Each opening starts from the loading state, as the dialog refetches.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setFetched(null);
  }
  const timeline = fetched?.key === requestKey ? fetched.state : LOADING_TIMELINE;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const key = `${projectId}#${issueNumber}#${updatedAt}`;
    api.githubIssueTimeline(projectId, issueNumber).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setFetched({ key, state: { status: 'ready', items: result.value.items } });
      } else {
        log.error('failed to load issue timeline', {
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
  }, [open, projectId, issueNumber, updatedAt]);

  return timeline;
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
  const timeline = useIssueTimeline(open, projectId, issue.number, issue.updated_at);
  const repoUrl = githubRepoBaseUrl(issue.html_url);

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
            <DialogTitle size="sm" leading="snug" data-testid="issue-detail-title">
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
                <IssueBadges issue={issue} projectId={projectId} />
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
                  data-testid="issue-detail-open-github"
                  render={
                    <a
                      href={issue.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('issues.viewOnGithub', 'View on GitHub')}
                    />
                  }
                >
                  <ExternalLink className="icon-xs" />
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
              <MarkdownBody body={issue.body} repoUrl={repoUrl} />
            </div>
            <IssueTimeline state={timeline} now={now} projectId={projectId} repoUrl={repoUrl} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
