import { memo } from 'react';

import type { ConflictBlock, ConflictResolution } from '@/lib/diff/types';

export const ConflictActionBar = memo(function ConflictActionBar({
  block,
  onResolve,
}: {
  block: ConflictBlock;
  onResolve?: (blockId: number, resolution: ConflictResolution) => void;
}) {
  if (!onResolve) return null;

  return (
    <div
      className="bg-conflict-action-bar flex h-[var(--diff-row-height)] items-center gap-1.5 px-2 py-0.5 font-sans text-(length:--diff-font-size)"
      data-testid={`conflict-actions-${block.id}`}
    >
      <span className="text-muted-foreground mr-1 font-medium">Conflict {block.id + 1}:</span>
      <button
        className="text-status-info hover:bg-status-info/20 hover:text-status-info text-2xs rounded px-1.5 py-0.5 font-medium transition-colors"
        onClick={() => onResolve(block.id, 'ours')}
        data-testid={`conflict-accept-current-${block.id}`}
      >
        Accept Current
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="text-status-interrupted hover:bg-status-interrupted/20 hover:text-status-interrupted text-2xs rounded px-1.5 py-0.5 font-medium transition-colors"
        onClick={() => onResolve(block.id, 'theirs')}
        data-testid={`conflict-accept-incoming-${block.id}`}
      >
        Accept Incoming
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="text-status-success hover:bg-status-success/20 hover:text-status-success text-2xs rounded px-1.5 py-0.5 font-medium transition-colors"
        onClick={() => onResolve(block.id, 'both')}
        data-testid={`conflict-accept-both-${block.id}`}
      >
        Accept Both
      </button>
    </div>
  );
});
