import type { GitHubPR } from '@funny/shared';
import { ChevronDown, ExternalLink, GitMerge, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { PRBadge } from '@/components/PRBadge';
import { getLastCommitAuthor } from '@/components/pull-requests/last-commit-author';
import { PRCreateThreadButton } from '@/components/pull-requests/PRCreateThreadButton';
import { PRMergeLine } from '@/components/pull-requests/PRMergeLine';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { timeAgo } from './pr-card-helpers';
import type { MergeMethod } from './use-pr-conversation';

interface PRCardSummaryProps {
  pr: GitHubPR;
  now: number;
  isMerged: boolean;
  canMerge: boolean;
  merging: boolean;
  handleMerge: (method: MergeMethod) => void;
  onCreateThreadForBranch?: (branch: string) => void;
}

/** The PR's title / meta / actions line: badge, title, merge line, authors, merge menu, links. */
export function PRCardSummary({
  pr,
  now,
  isMerged,
  canMerge,
  merging,
  handleMerge,
  onCreateThreadForBranch,
}: PRCardSummaryProps) {
  const { t } = useTranslation();
  const lastCommitAuthor = getLastCommitAuthor(pr);

  const mergeMethods: Array<{ method: MergeMethod; label: string; hint: string }> = [
    {
      method: 'squash',
      label: t('review.pullRequests.squashAndMerge', 'Squash and merge'),
      hint: t('review.pullRequests.squashHint', 'Combine all commits into one'),
    },
    {
      method: 'merge',
      label: t('review.pullRequests.createMergeCommit', 'Create a merge commit'),
      hint: t('review.pullRequests.mergeHint', 'Keep all commits'),
    },
    {
      method: 'rebase',
      label: t('review.pullRequests.rebaseAndMerge', 'Rebase and merge'),
      hint: t('review.pullRequests.rebaseHint', 'Rebase commits onto the base'),
    },
  ];

  return (
    <div className="flex items-start gap-2" data-testid={`pinned-pr-summary-${pr.number}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-1.5">
          <PRBadge
            prNumber={pr.number}
            prState={isMerged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN'}
            prUrl={pr.html_url}
            size="xxs"
            data-testid={`pinned-pr-link-${pr.number}`}
          />
          <span className="text-sm font-semibold">{pr.title}</span>
        </div>
        <PRMergeLine pr={pr} data-testid={`pinned-pr-merge-line-${pr.number}`} />
        <div className="text-muted-foreground text-2xs flex items-center gap-1.5">
          {pr.user && <AuthorBadge name={pr.user.login} avatarUrl={pr.user.avatar_url} size="xs" />}
          {pr.user ? <span>&middot;</span> : null}
          <span>
            {t('review.pullRequests.updated', 'Updated')} {timeAgo(pr.updated_at, now)}
          </span>
          {lastCommitAuthor ? (
            <>
              <span>&middot;</span>
              <span>{t('review.pullRequests.lastCommitBy', 'Last commit by')}</span>
              <AuthorBadge
                name={lastCommitAuthor.name}
                avatarUrl={lastCommitAuthor.avatarUrl}
                size="xs"
              />
            </>
          ) : null}
          {pr.draft ? (
            <>
              <span>&middot;</span>
              <Badge size="xxs" variant="outline">
                {t('review.pullRequests.draft', 'Draft')}
              </Badge>
            </>
          ) : null}
        </div>
      </div>
      {canMerge && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              gap="tight"
              className="shrink-0"
              disabled={merging}
              data-testid={`pinned-pr-merge-${pr.number}`}
            >
              {merging ? (
                <Loader2 className="icon-xs animate-spin" />
              ) : (
                <GitMerge className="icon-xs" />
              )}
              {t('review.pullRequests.merge', 'Merge')}
              <ChevronDown className="icon-xs" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              {t('review.pullRequests.mergeMethod', 'Merge method')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {mergeMethods.map(({ method, label, hint }) => (
              <DropdownMenuItem
                key={method}
                onSelect={() => handleMerge(method)}
                className="flex flex-col items-start"
                data-testid={`pinned-pr-merge-${method}-${pr.number}`}
              >
                <span className="text-xs font-medium">{label}</span>
                <span className="text-muted-foreground text-2xs mt-0.5">{hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onCreateThreadForBranch && (
        <PRCreateThreadButton
          prNumber={pr.number}
          branch={pr.head.ref}
          onCreateThread={onCreateThreadForBranch}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="muted"
            size="icon-xs"
            asChild
            className="shrink-0"
            data-testid={`pinned-pr-open-github-${pr.number}`}
          >
            <a
              href={pr.html_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open pull request ${pr.number} on GitHub`}
            >
              <ExternalLink className="icon-xs" />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Open on GitHub</TooltipContent>
      </Tooltip>
    </div>
  );
}
