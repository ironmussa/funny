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
import { cn } from '@/lib/utils';

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

const eventConfig: Record<string, { icon: typeof GitCommit; label: string; color: string }> = {
  'git:commit': {
    icon: GitCommit,
    label: 'Committed',
    color: 'border-emerald-500/20 bg-emerald-500/5',
  },
  'git:push': { icon: Upload, label: 'Pushed', color: 'border-blue-500/20 bg-blue-500/5' },
  'git:merge': { icon: GitMerge, label: 'Merged', color: 'border-purple-500/20 bg-purple-500/5' },
  'git:pr_created': {
    icon: GitPullRequest,
    label: 'PR Created',
    color: 'border-orange-500/20 bg-orange-500/5',
  },
  'git:stage': { icon: Plus, label: 'Staged', color: 'border-emerald-500/20 bg-emerald-500/5' },
  'git:unstage': { icon: Minus, label: 'Unstaged', color: 'border-yellow-500/20 bg-yellow-500/5' },
  'git:revert': { icon: Undo2, label: 'Reverted', color: 'border-red-500/20 bg-red-500/5' },
  'git:pull': { icon: Download, label: 'Pulled', color: 'border-blue-500/20 bg-blue-500/5' },
  'git:stash': { icon: Archive, label: 'Stashed', color: 'border-amber-500/20 bg-amber-500/5' },
  'git:stash_pop': {
    icon: ArchiveRestore,
    label: 'Stash Popped',
    color: 'border-amber-500/20 bg-amber-500/5',
  },
  'git:reset_soft': {
    icon: RotateCcw,
    label: 'Undo Commit',
    color: 'border-red-500/20 bg-red-500/5',
  },
};

const iconColor: Record<string, string> = {
  'git:commit': 'text-emerald-600',
  'git:push': 'text-blue-600',
  'git:merge': 'text-purple-600',
  'git:pr_created': 'text-orange-600',
  'git:stage': 'text-emerald-600',
  'git:unstage': 'text-yellow-600',
  'git:revert': 'text-red-600',
  'git:pull': 'text-blue-600',
  'git:stash': 'text-amber-600',
  'git:stash_pop': 'text-amber-600',
  'git:reset_soft': 'text-red-600',
};

export const GitEventCard = memo(function GitEventCard({ event }: { event: ThreadEvent }) {
  const { t } = useTranslation();
  const config = eventConfig[event.type];
  if (!config) return null;

  const Icon = config.icon;
  const metadata = parseEventData(event.data);

  return (
    <div
      className={cn('rounded-lg border px-3 py-2 text-xs flex items-center gap-2', config.color)}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor[event.type])} />
      <span className={cn('font-medium shrink-0', iconColor[event.type])}>{config.label}</span>
      {metadata.message && (
        <span className="truncate text-muted-foreground">{metadata.message}</span>
      )}
      {metadata.title && metadata.url && (
        <a
          href={metadata.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('truncate hover:underline', iconColor[event.type])}
        >
          {metadata.title}
        </a>
      )}
      {metadata.sourceBranch && metadata.targetBranch && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {metadata.sourceBranch} → {metadata.targetBranch}
        </span>
      )}
      {metadata.paths && Array.isArray(metadata.paths) && (
        <span className="truncate text-muted-foreground">
          {metadata.paths.length === 1 ? metadata.paths[0] : `${metadata.paths.length} files`}
        </span>
      )}
      {metadata.output && !metadata.paths && !metadata.message && !metadata.title && (
        <span className="truncate text-muted-foreground">
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
