import { AlertCircle, CheckCircle2, Clock, GitMerge, GitPullRequest } from 'lucide-react';

import { LabelBadge } from '@/components/ui/label-badge';

export function PRStateBadge({ draft }: { state: string; draft: boolean; merged: boolean }) {
  if (!draft) return null;
  return (
    <LabelBadge tone="neutral">
      <GitPullRequest className="size-2.5" />
      Draft
    </LabelBadge>
  );
}

export function ReviewDecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return null;
  switch (decision) {
    case 'APPROVED':
      return (
        <span className="text-status-success flex items-center gap-1 text-xs">
          <CheckCircle2 className="size-3.5" /> Approved
        </span>
      );
    case 'CHANGES_REQUESTED':
      return (
        <span className="text-status-error flex items-center gap-1 text-xs">
          <AlertCircle className="size-3.5" /> Changes requested
        </span>
      );
    case 'REVIEW_REQUIRED':
      return (
        <span className="text-status-pending flex items-center gap-1 text-xs">
          <Clock className="size-3.5" /> Review required
        </span>
      );
    default:
      return null;
  }
}

export function MergeStatus({ mergeable, merged }: { mergeable: string; merged: boolean }) {
  if (merged) return null;
  switch (mergeable) {
    case 'mergeable':
      return (
        <span className="text-status-success flex items-center gap-1 text-xs">
          <GitMerge className="size-3.5" /> Ready to merge
        </span>
      );
    case 'conflicting':
      return (
        <span className="text-status-error flex items-center gap-1 text-xs">
          <AlertCircle className="size-3.5" /> Merge conflicts
        </span>
      );
    default:
      return null;
  }
}
