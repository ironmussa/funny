import type { EnrichedGitHubIssue } from '@funny/shared';

import { BranchBadge } from '@/components/BranchBadge';
import { PRBadge } from '@/components/PRBadge';
import { LabelBadge } from '@/components/ui/label-badge';

function toPRBadgeState(state: string): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (state === 'merged') return 'MERGED';
  if (state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** Label, linked-branch, and linked-PR badges shown in an issue's metadata row. */
export function IssueBadges({ issue }: { issue: EnrichedGitHubIssue }) {
  return (
    <>
      {issue.labels.map((label) => (
        <LabelBadge key={label.name} color={label.color}>
          {label.name}
        </LabelBadge>
      ))}
      {issue.linkedBranch && (
        <BranchBadge
          branch={issue.linkedBranch}
          size="xs"
          className="max-w-40"
          data-testid={`issue-linked-branch-${issue.number}`}
        />
      )}
      {issue.linkedPR && (
        <PRBadge
          prNumber={issue.linkedPR.number}
          prState={toPRBadgeState(issue.linkedPR.state)}
          prUrl={issue.linkedPR.url}
          size="compact"
        />
      )}
    </>
  );
}
