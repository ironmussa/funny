import { CircleCheck, CircleDot } from 'lucide-react';
import type { SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { GIT_STAT_CHIP_CLASS, GIT_STAT_ICON_CLASS } from '@/components/git/GitStatChip';
import { GitHubExternalLink } from '@/components/GitHubExternalLink';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { openGitHubItem } from '@/stores/github-item-viewer-store';

/**
 * An issue number is a reference, not a state: muted, as on GitHub. Every git
 * color is taken (blue is unpushed commits, green/violet/red the PR states).
 */
const ISSUE_CHIP_COLOR_CLASS = 'text-muted-foreground';

/**
 * An issue's number as a chip, the one funny uses everywhere an issue is named
 * (the factory board, the Issues tab). Always muted, so it reads apart from a
 * PR chip beside it and from the unpushed-commits chip, whose colors are
 * states; the icon, in the issue's state color, says open or closed. A click
 * opens funny's issue view; the arrow beside it, GitHub.
 */
export function IssueChip({
  projectId,
  number,
  closed,
  githubUrl,
  showStateIcon = true,
  'data-testid': testId,
}: {
  projectId: string;
  number: number;
  closed: boolean;
  /** The issue on GitHub; without it, no arrow. */
  githubUrl: string | undefined;
  /** Off where the row already shows the issue's state. */
  showStateIcon?: boolean;
  'data-testid': string;
}) {
  const { t } = useTranslation();
  const label = t('factoryView.issueTitle', 'Issue #{{number}}', { number });
  const StateIcon = closed ? CircleCheck : CircleDot;
  const openInFunny = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openGitHubItem({ kind: 'issue', projectId, number, url: githubUrl });
  };

  return (
    <Badge variant="subtle" size="stat-group" weight="normal" corners="square">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openInFunny}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              GIT_STAT_CHIP_CLASS,
              ISSUE_CHIP_COLOR_CLASS,
              'focus-visible:ring-ring rounded-sm hover:underline focus-visible:ring-1 focus-visible:outline-none',
            )}
            data-testid={testId}
            aria-label={label}
          >
            {showStateIcon && (
              <StateIcon
                className={cn(
                  GIT_STAT_ICON_CLASS,
                  closed ? 'text-status-violet' : 'text-status-success',
                )}
                aria-hidden="true"
                data-testid={`${testId}-icon-${closed ? 'closed' : 'open'}`}
              />
            )}
            <span className="font-mono">#{number}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      {githubUrl && (
        <GitHubExternalLink
          url={githubUrl}
          iconClassName={GIT_STAT_ICON_CLASS}
          className={ISSUE_CHIP_COLOR_CLASS}
          data-testid={`${testId}-external`}
        />
      )}
    </Badge>
  );
}
