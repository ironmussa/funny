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
      className="flex items-center gap-1.5 px-2 py-0.5 font-sans text-[length:var(--diff-font-size)]"
      style={{ height: 'var(--diff-row-height)', backgroundColor: 'hsl(210 80% 55% / 0.10)' }}
      data-testid={`conflict-actions-${block.id}`}
    >
      <span className="mr-1 font-medium text-muted-foreground">Conflict {block.id + 1}:</span>
      <button
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300"
        onClick={() => onResolve(block.id, 'ours')}
        data-testid={`conflict-accept-current-${block.id}`}
      >
        Accept Current
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-orange-400 transition-colors hover:bg-orange-500/20 hover:text-orange-300"
        onClick={() => onResolve(block.id, 'theirs')}
        data-testid={`conflict-accept-incoming-${block.id}`}
      >
        Accept Incoming
      </button>
      <span className="text-muted-foreground/40">|</span>
      <button
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 hover:text-emerald-300"
        onClick={() => onResolve(block.id, 'both')}
        data-testid={`conflict-accept-both-${block.id}`}
      >
        Accept Both
      </button>
    </div>
  );
});
