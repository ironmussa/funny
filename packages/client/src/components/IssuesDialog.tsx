import type { EnrichedGitHubIssue } from '@funny/shared';
import {
  CircleDot,
  CircleCheck,
  MessageSquare,
  Loader2,
  ExternalLink,
  GitBranch,
  Plus,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';

export interface IssueThreadParams {
  prompt: string;
  branchName: string;
  title: string;
}

interface IssuesDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateThread?: (params: IssueThreadParams) => void;
}

export function IssuesDialog({ projectId, open, onOpenChange, onCreateThread }: IssuesDialogProps) {
  const { t } = useTranslation();
  const [issues, setIssues] = useState<EnrichedGitHubIssue[]>([]);
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string } | null>(null);

  const fetchIssues = useCallback(
    async (pageNum: number, append: boolean) => {
      setLoading(true);
      setError(null);
      const result = await api.githubIssuesEnriched(projectId, {
        state,
        page: pageNum,
        per_page: 30,
      });
      result.match(
        (data) => {
          setIssues((prev) => (append ? [...prev, ...data.issues] : data.issues));
          setHasMore(data.hasMore);
          setRepoInfo({ owner: data.owner, repo: data.repo });
        },
        (err) => {
          setError(err.message);
        },
      );
      setLoading(false);
    },
    [projectId, state],
  );

  useEffect(() => {
    if (open) {
      setPage(1);
      setIssues([]);
      fetchIssues(1, false);
    }
  }, [open, state, fetchIssues]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchIssues(next, true);
  };

  const handleCreateThread = useCallback(
    (issue: EnrichedGitHubIssue) => {
      if (!onCreateThread || !repoInfo) return;
      onCreateThread({
        prompt: buildIssueThreadPrompt(issue, repoInfo),
        branchName: issue.suggestedBranchName,
        title: issue.title,
      });
    },
    [onCreateThread, repoInfo],
  );

  function timeAgo(dateStr: string): string {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDot className="icon-base" />
            {t('issues.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('issues.title')}</DialogDescription>
        </DialogHeader>

        {/* State filter */}
        <div className="flex gap-1">
          <Button
            variant={state === 'open' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setState('open')}
            className="h-7 text-xs"
            data-testid="issues-filter-open"
          >
            <CircleDot className="icon-xs mr-1 text-green-500" />
            {t('issues.open')}
          </Button>
          <Button
            variant={state === 'closed' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setState('closed')}
            className="h-7 text-xs"
            data-testid="issues-filter-closed"
          >
            <CircleCheck className="icon-xs mr-1 text-purple-500" />
            {t('issues.closed')}
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="-mx-6 min-h-0 flex-1 px-6">
          {loading && issues.length === 0 ? (
            <LoadingState
              fill={false}
              className="py-12"
              testId="issues-loading"
              label={t('common.loading', 'Loading…')}
            />
          ) : error ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              <p>{t('issues.error')}</p>
              <p className="mt-1 text-xs">{error}</p>
            </div>
          ) : issues.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              {t('issues.noIssues')}
            </div>
          ) : (
            <div className="space-y-1">
              {issues.map((issue) => (
                <div
                  key={issue.number}
                  className="group hover:bg-accent/50 flex items-start gap-2 rounded-md p-2 transition-colors"
                  data-testid={`issue-item-${issue.number}`}
                >
                  {issue.state === 'open' ? (
                    <CircleDot className="icon-base mt-0.5 shrink-0 text-green-500" />
                  ) : (
                    <CircleCheck className="icon-base mt-0.5 shrink-0 text-purple-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <a
                        href={issue.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary line-clamp-2 text-sm font-medium transition-colors"
                      >
                        {issue.title}
                      </a>
                    </div>
                    {issue.body ? (
                      <p
                        className="text-muted-foreground mt-1 line-clamp-3 text-xs whitespace-pre-wrap"
                        data-testid={`issue-body-${issue.number}`}
                      >
                        {issue.body}
                      </p>
                    ) : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground text-xs">#{issue.number}</span>
                      {issue.labels.map((label) => (
                        <Badge
                          key={label.name}
                          variant="outline"
                          className="h-4 px-1 text-[10px]"
                          style={{
                            borderColor: `#${label.color}`,
                            color: `#${label.color}`,
                          }}
                        >
                          {label.name}
                        </Badge>
                      ))}

                      {/* Linked branch badge */}
                      {issue.linkedBranch && (
                        <Badge
                          variant="outline"
                          className="h-4 gap-0.5 border-emerald-500/30 px-1 text-[10px] text-emerald-500"
                        >
                          <GitBranch className="size-2.5" />
                          <span className="max-w-[100px] truncate">{issue.linkedBranch}</span>
                        </Badge>
                      )}

                      {/* Linked PR badge */}
                      {issue.linkedPR && (
                        <PRBadge
                          prNumber={issue.linkedPR.number}
                          prState={
                            issue.linkedPR.state === 'merged'
                              ? 'MERGED'
                              : issue.linkedPR.state === 'closed'
                                ? 'CLOSED'
                                : 'OPEN'
                          }
                          prUrl={issue.linkedPR.url}
                          size="xxs"
                        />
                      )}

                      <span className="text-muted-foreground text-xs">
                        {timeAgo(issue.created_at)}
                      </span>
                      {issue.user && (
                        <span className="text-muted-foreground text-xs">{issue.user.login}</span>
                      )}
                      {issue.comments > 0 && (
                        <span className="text-muted-foreground flex items-center gap-0.5 text-xs">
                          <MessageSquare className="icon-xs" />
                          {issue.comments}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Create thread button — only for issues without a linked branch */}
                  {onCreateThread && !issue.linkedBranch && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => handleCreateThread(issue)}
                          data-testid={`issue-create-thread-${issue.number}`}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        <p>{t('issues.createThread')}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ))}

              {hasMore && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      loadMore();
                    }}
                    disabled={loading}
                    className="text-xs"
                    data-testid="issues-load-more"
                  >
                    {loading ? <Loader2 className="icon-xs mr-1 animate-spin" /> : null}
                    {t('issues.loadMore')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {repoInfo && (
          <div className="flex justify-end border-t pt-2">
            <a
              href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              {t('issues.viewOnGithub')}
              <ExternalLink className="icon-xs" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
