import type { EnrichedGitHubIssue } from '@funny/shared';
import { Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { PRBadge } from '@/components/PRBadge';
import { LabelBadge } from '@/components/ui/label-badge';

function toPRBadgeState(state: string): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (state === 'merged') return 'MERGED';
  if (state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/**
 * The issue's GitHub labels. Where they sit among funny's own chips they carry
 * a tag icon to read apart; next to the title, as on GitHub, they go without
 * (`plain`).
 */
export function IssueLabelBadges({
  issue,
  plain = false,
  className,
  onLabelClick,
  activeLabels,
}: {
  issue: EnrichedGitHubIssue;
  plain?: boolean;
  className?: string;
  /**
   * When set, each label chip becomes a button: clicking it toggles that label
   * as an issue filter. Without it the chips are plain, non-interactive tags.
   */
  onLabelClick?: (name: string) => void;
  /** Names of the labels currently used as filters, shown pressed. */
  activeLabels?: readonly string[];
}) {
  const { t } = useTranslation();
  return (
    <>
      {issue.labels.map((label) => {
        if (!onLabelClick) {
          return (
            <LabelBadge
              key={label.name}
              color={label.color}
              className={className}
              data-testid={`issue-label-${issue.number}-${label.name}`}
            >
              {!plain && <Tag className="size-2.5 shrink-0" aria-hidden />}
              {label.name}
            </LabelBadge>
          );
        }
        const active = activeLabels?.includes(label.name) ?? false;
        return (
          <LabelBadge
            key={label.name}
            color={label.color}
            className={className}
            interactive
            active={active}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            title={
              active
                ? t(
                    'review.issues.filter.removeLabelFilter',
                    'Remove the “{{label}}” label filter',
                    {
                      label: label.name,
                    },
                  )
                : t('review.issues.filter.filterByLabel', 'Filter by label “{{label}}”', {
                    label: label.name,
                  })
            }
            onClick={(e) => {
              // The chip sits inside the row's clickable title line; keep its
              // click from opening the issue.
              e.stopPropagation();
              onLabelClick(label.name);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onLabelClick(label.name);
              }
            }}
            data-testid={`issue-label-${issue.number}-${label.name}`}
          >
            {!plain && <Tag className="size-2.5 shrink-0" aria-hidden />}
            {label.name}
          </LabelBadge>
        );
      })}
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
