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
      className="flex items-center gap-1.5 px-2 py-0.5 font-sans text-(length:--diff-font-size)"
      style={{ height: 'var(--diff-row-height)', backgroundColor: 'hsl(210 80% 55% / 0.10)' }}
      data-testid={`conflict-actions-${block.id}`}
    >
      <span className="text-muted-foreground mr-1 font-medium">Conflict {block.id + 1}:</span>
      <button
        className="text-status-info hover:bg-status-info/20 hover:text-status-info rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
        onClick={() => onResolve(block.id, 'ours')}
        data-testid={`conflict-accept-current-${block.id}`}
      >
        Accept Current
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="text-status-interrupted hover:bg-status-interrupted/20 hover:text-status-interrupted rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
        onClick={() => onResolve(block.id, 'theirs')}
        data-testid={`conflict-accept-incoming-${block.id}`}
      >
        Accept Incoming
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="text-status-success hover:bg-status-success/20 hover:text-status-success rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
        onClick={() => onResolve(block.id, 'both')}
        data-testid={`conflict-accept-both-${block.id}`}
      >
        Accept Both
      </button>
    </div>
  );
});
