import type { EnrichedGitHubIssue } from '@funny/shared';
import { GitBranch } from 'lucide-react';

import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function toPRBadgeState(state: string): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (state === 'merged') return 'MERGED';
  if (state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** Label, linked-branch, and linked-PR badges shown in an issue's metadata row. */
export function IssueBadges({
  issue,
  badgeClassName,
}: {
  issue: EnrichedGitHubIssue;
  /** Size classes applied to every label and branch badge. */
  badgeClassName: string;
}) {
  return (
    <>
      {issue.labels.map((label) => (
        <Badge
          key={label.name}
          variant="outline"
          className={cn('px-1', badgeClassName)}
          style={{
            borderColor: `#${label.color}`,
            color: `#${label.color}`,
          }}
        >
          {label.name}
        </Badge>
      ))}
      {issue.linkedBranch && (
        <Badge
          variant="outline"
          className={cn('gap-0.5 border-emerald-500/30 px-1 text-emerald-500', badgeClassName)}
        >
          <GitBranch className="size-2.5" />
          <span className="max-w-[100px] truncate">{issue.linkedBranch}</span>
        </Badge>
      )}
      {issue.linkedPR && (
        <PRBadge
          prNumber={issue.linkedPR.number}
          prState={toPRBadgeState(issue.linkedPR.state)}
          prUrl={issue.linkedPR.url}
          size="xxs"
        />
      )}
    </>
  );
}
