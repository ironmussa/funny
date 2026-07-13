/**
 * GitEventCard — Compact inline card for git operation events (commit, push, merge, PR).
 * Displayed inline in the thread chat timeline.
 */

import type { ThreadEvent } from '@funny/shared';
import {
  ChevronRight,
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
import { memo, useMemo, useState } from 'react';
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
  const [expanded, setExpanded] = useState(false);
  const metadata = useMemo(() => parseEventData(event.data), [event.data]);
  const config = eventConfig[event.type];
  if (!config) return null;

  const Icon = config.icon;
  const output = typeof metadata.output === 'string' ? metadata.output.trim() : '';

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        <Icon className="icon-xs text-muted-foreground shrink-0" />
        <span className="text-foreground shrink-0 font-mono font-medium">{config.label}</span>
        {metadata.message && (
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {metadata.message}
          </span>
        )}
        {metadata.title && metadata.url && (
          <span className="text-muted-foreground min-w-0 truncate font-mono">{metadata.title}</span>
        )}
        {metadata.sourceBranch && metadata.targetBranch && (
          <span className="text-muted-foreground font-mono">
            {metadata.sourceBranch} → {metadata.targetBranch}
          </span>
        )}
        {metadata.paths && Array.isArray(metadata.paths) && (
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {metadata.paths.length === 1 ? metadata.paths[0] : `${metadata.paths.length} files`}
          </span>
        )}
        {output && !metadata.paths && !metadata.message && !metadata.title && (
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {output.split('\n')[0].slice(0, 80)}
          </span>
        )}
        {event.createdAt && (
          <span className="thread-timestamp text-muted-foreground/50 ml-auto">
            {timeAgo(event.createdAt, t)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-border/40 border-t px-3 py-2">
          <pre className="text-muted-foreground max-h-[40vh] overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {output || JSON.stringify(metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
});
