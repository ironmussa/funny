import { AlertCircle, CheckCircle2, Clock, GitMerge, GitPullRequest } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

export function PRStateBadge({ draft }: { state: string; draft: boolean; merged: boolean }) {
  if (!draft) return null;
  return (
    <Badge
      variant="outline"
      size="xxs"
      className="border-muted-foreground/30 bg-muted text-muted-foreground gap-1"
    >
      <GitPullRequest className="size-2.5" />
      Draft
    </Badge>
  );
}

export function ReviewDecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return null;
  switch (decision) {
    case 'APPROVED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <CheckCircle2 className="size-3.5" /> Approved
        </span>
      );
    case 'CHANGES_REQUESTED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="size-3.5" /> Changes requested
        </span>
      );
    case 'REVIEW_REQUIRED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-yellow-400">
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
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <GitMerge className="size-3.5" /> Ready to merge
        </span>
      );
    case 'conflicting':
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="size-3.5" /> Merge conflicts
        </span>
      );
    default:
      return null;
  }
}
