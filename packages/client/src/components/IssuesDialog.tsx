import type { GitHubIssue } from '@funny/shared';
import { CircleDot, CircleCheck, MessageSquare, Loader2, ExternalLink } from 'lucide-react';
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
import { api } from '@/lib/api';

interface IssuesDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IssuesDialog({ projectId, open, onOpenChange }: IssuesDialogProps) {
  const { t } = useTranslation();
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
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
      const result = await api.githubIssues(projectId, { state, page: pageNum, per_page: 30 });
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
            <CircleDot className="h-4 w-4" />
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
          >
            <CircleDot className="mr-1 h-3 w-3 text-green-500" />
            {t('issues.open')}
          </Button>
          <Button
            variant={state === 'closed' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setState('closed')}
            className="h-7 text-xs"
          >
            <CircleCheck className="mr-1 h-3 w-3 text-purple-500" />
            {t('issues.closed')}
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="-mx-6 min-h-0 flex-1 px-6">
          {loading && issues.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
                <a
                  key={issue.number}
                  href={issue.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-2 rounded-md p-2 transition-colors hover:bg-accent/50"
                >
                  {issue.state === 'open' ? (
                    <CircleDot className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500" />
                  ) : (
                    <CircleCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-purple-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="line-clamp-2 text-sm font-medium transition-colors group-hover:text-primary">
                        {issue.title}
                      </span>
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
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(issue.created_at)}
                      </span>
                      {issue.user && (
                        <span className="text-xs text-muted-foreground">{issue.user.login}</span>
                      )}
                      {issue.comments > 0 && (
                        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                          <MessageSquare className="h-3 w-3" />
                          {issue.comments}
                        </span>
                      )}
                    </div>
                  </div>
                </a>
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
                  >
                    {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
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
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
