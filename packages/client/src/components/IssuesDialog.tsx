import type { EnrichedGitHubIssue } from '@funny/shared';
import {
  CircleDot,
  CircleCheck,
  MessageSquare,
  Loader2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Plus,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';

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
      const lines = [
        `Fix GitHub issue #${issue.number}: ${issue.title}`,
        `URL: https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${issue.number}`,
      ];
      if (issue.body) {
        lines.push('', 'Issue description:', issue.body);
      }
      if (issue.labels.length > 0) {
        lines.push('', `Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
      }
      onCreateThread({
        prompt: lines.join('\n'),
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="icon-lg animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <p>{t('issues.error')}</p>
              <p className="mt-1 text-xs">{error}</p>
            </div>
          ) : issues.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('issues.noIssues')}
            </div>
          ) : (
            <div className="space-y-1">
              {issues.map((issue) => (
                <div
                  key={issue.number}
                  className="group flex items-start gap-2 rounded-md p-2 transition-colors hover:bg-accent/50"
                  data-testid={`issue-item-${issue.number}`}
                >
                  {issue.state === 'open' ? (
                    <CircleDot className="icon-base mt-0.5 flex-shrink-0 text-green-500" />
                  ) : (
                    <CircleCheck className="icon-base mt-0.5 flex-shrink-0 text-purple-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <a
                        href={issue.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 text-sm font-medium transition-colors hover:text-primary"
                      >
                        {issue.title}
                      </a>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{issue.number}</span>
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
                          <GitBranch className="h-2.5 w-2.5" />
                          <span className="max-w-[100px] truncate">{issue.linkedBranch}</span>
                        </Badge>
                      )}

                      {/* Linked PR badge */}
                      {issue.linkedPR && (
                        <a
                          href={issue.linkedPR.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Badge
                            variant="outline"
                            className="h-4 gap-0.5 border-blue-500/30 px-1 text-[10px] text-blue-500 hover:bg-blue-500/10"
                          >
                            <GitPullRequest className="h-2.5 w-2.5" />#{issue.linkedPR.number}
                          </Badge>
                        </a>
                      )}

                      <span className="text-xs text-muted-foreground">
                        {timeAgo(issue.created_at)}
                      </span>
                      {issue.user && (
                        <span className="text-xs text-muted-foreground">{issue.user.login}</span>
                      )}
                      {issue.comments > 0 && (
                        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
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
                          className="h-6 w-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => handleCreateThread(issue)}
                          data-testid={`issue-create-thread-${issue.number}`}
                        >
                          <Plus className="h-3.5 w-3.5" />
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
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
