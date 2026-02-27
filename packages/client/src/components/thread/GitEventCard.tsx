/**
 * GitEventCard — Compact inline card for git operation events (commit, push, merge, PR).
 * Displayed inline in the thread chat timeline.
 */

import type { ThreadEvent } from '@funny/shared';
import {
  GitCommit,
  Upload,
  GitMerge,
  GitPullRequest,
  Plus,
  Minus,
  Undo2,
  Download,
  Archive,
  ArchiveRestore,
  RotateCcw,
} from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { timeAgo } from '@/lib/thread-utils';

function parseEventData(data: string | Record<string, unknown>): Record<string, any> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, any>;
}

const eventConfig: Record<string, { icon: typeof GitCommit; label: string }> = {
  'git:commit': { icon: GitCommit, label: 'Committed' },
  'git:push': { icon: Upload, label: 'Pushed' },
  'git:merge': { icon: GitMerge, label: 'Merged' },
  'git:pr_created': { icon: GitPullRequest, label: 'PR Created' },
  'git:stage': { icon: Plus, label: 'Staged' },
  'git:unstage': { icon: Minus, label: 'Unstaged' },
  'git:revert': { icon: Undo2, label: 'Reverted' },
  'git:pull': { icon: Download, label: 'Pulled' },
  'git:stash': { icon: Archive, label: 'Stashed' },
  'git:stash_pop': { icon: ArchiveRestore, label: 'Stash Popped' },
  'git:reset_soft': { icon: RotateCcw, label: 'Undo Commit' },
};

export const GitEventCard = memo(function GitEventCard({ event }: { event: ThreadEvent }) {
  const { t } = useTranslation();
  const config = eventConfig[event.type];
  if (!config) return null;

  const Icon = config.icon;
  const metadata = parseEventData(event.data);

  return (
    <div className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-accent/30">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-mono font-medium text-foreground">{config.label}</span>
      {metadata.message && (
        <span className="min-w-0 truncate font-mono text-muted-foreground">{metadata.message}</span>
      )}
      {metadata.title && metadata.url && (
        <a
          href={metadata.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate font-mono text-muted-foreground hover:text-primary hover:underline"
        >
          {metadata.title}
        </a>
      )}
      {metadata.sourceBranch && metadata.targetBranch && (
        <span className="font-mono text-muted-foreground">
          {metadata.sourceBranch} → {metadata.targetBranch}
        </span>
      )}
      {metadata.paths && Array.isArray(metadata.paths) && (
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {metadata.paths.length === 1 ? metadata.paths[0] : `${metadata.paths.length} files`}
        </span>
      )}
      {metadata.output && !metadata.paths && !metadata.message && !metadata.title && (
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {metadata.output.split('\n')[0].slice(0, 80)}
        </span>
      )}
      {event.createdAt && (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {timeAgo(event.createdAt, t)}
        </span>
      )}
    </div>
  );
});
