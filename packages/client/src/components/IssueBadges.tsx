import type { EnrichedGitHubIssue } from '@funny/shared';
import { Tag } from 'lucide-react';

import { BranchBadge } from '@/components/BranchBadge';
import { PRBadge } from '@/components/PRBadge';
import { LabelBadge } from '@/components/ui/label-badge';

function toPRBadgeState(state: string): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (state === 'merged') return 'MERGED';
  if (state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** The issue's GitHub labels, each with a tag icon so they read apart from funny's own chips. */
export function IssueLabelBadges({ issue }: { issue: EnrichedGitHubIssue }) {
  return (
    <>
      {issue.labels.map((label) => (
        <LabelBadge
          key={label.name}
          color={label.color}
          data-testid={`issue-label-${issue.number}-${label.name}`}
        >
          <Tag className="size-2.5 shrink-0" aria-hidden />
          {label.name}
        </LabelBadge>
      ))}
    </>
  );
}

/** The branch and pull request linked to the issue. */
export function IssueLinkBadges({
  issue,
  projectId,
}: {
  issue: EnrichedGitHubIssue;
  /** The issue's project: the linked PR chip opens funny's PR view. */
  projectId?: string;
}) {
  return (
    <>
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
          projectId={projectId}
          size="compact"
        />
      )}
    </>
  );
}

/** Label, linked-branch, and linked-PR badges shown in an issue's metadata row. */
export function IssueBadges({
  issue,
  projectId,
}: {
  issue: EnrichedGitHubIssue;
  projectId?: string;
}) {
  return (
    <>
      <IssueLabelBadges issue={issue} />
      <IssueLinkBadges issue={issue} projectId={projectId} />
    </>
  );
}
