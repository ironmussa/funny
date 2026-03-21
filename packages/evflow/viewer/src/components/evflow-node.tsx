import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

import { cn } from '@/lib/utils';

import type { ElementKind, SourceRef } from '../../../src/types';

const KIND_BORDERS: Record<ElementKind, string> = {
  command: 'border-blue-500',
  event: 'border-amber-500',
  aggregate: 'border-violet-500',
  readModel: 'border-emerald-500',
  screen: 'border-cyan-500',
  automation: 'border-gray-500',
  external: 'border-red-500',
  saga: 'border-pink-500',
};

const KIND_BGS: Record<ElementKind, string> = {
  command: 'bg-blue-500/10',
  event: 'bg-amber-500/10',
  aggregate: 'bg-violet-500/10',
  readModel: 'bg-emerald-500/10',
  screen: 'bg-cyan-500/10',
  automation: 'bg-gray-500/10',
  external: 'bg-red-500/10',
  saga: 'bg-pink-500/10',
};

const KIND_BGS_HIGHLIGHT: Record<ElementKind, string> = {
  command: 'bg-blue-500/25',
  event: 'bg-amber-500/25',
  aggregate: 'bg-violet-500/25',
  readModel: 'bg-emerald-500/25',
  screen: 'bg-cyan-500/25',
  automation: 'bg-gray-500/25',
  external: 'bg-red-500/25',
  saga: 'bg-pink-500/25',
};

export interface EvflowNodeData {
  label: string;
  kind: ElementKind;
  description?: string;
  slices: string[];
  fields?: Record<string, string>;
  invariants?: string[];
  source?: SourceRef;
  highlighted?: boolean;
  dimmed?: boolean;
}

export const EvflowNode = memo(function EvflowNode({
  data,
  selected,
}: NodeProps & { data: EvflowNodeData }) {
  const kind = data.kind;
  const borderClass = KIND_BORDERS[kind] ?? 'border-zinc-600';
  const bgClass = data.highlighted
    ? (KIND_BGS_HIGHLIGHT[kind] ?? 'bg-zinc-800/50')
    : (KIND_BGS[kind] ?? 'bg-zinc-800/50');

  return (
    <div
      className={cn(
        'px-3 py-2 rounded-lg border-2 min-w-[160px] max-w-[220px] transition-all duration-200',
        borderClass,
        bgClass,
        selected && 'ring-2 ring-white/50 shadow-xl scale-105',
        data.highlighted && !selected && 'ring-1 ring-white/20 shadow-lg',
        data.dimmed && 'opacity-20',
        !data.dimmed && !data.highlighted && !selected && 'shadow-sm',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-zinc-400" />

      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <div
            className={cn(
              'text-xs font-semibold truncate flex-1',
              data.dimmed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {data.label}
          </div>
          {data.source && (
            <span
              className={cn(
                'text-[10px] shrink-0',
                data.dimmed ? 'text-muted-foreground/30' : 'text-muted-foreground/60',
              )}
              title={data.source.file}
            >
              {'</>'}
            </span>
          )}
        </div>
        <div
          className={cn(
            'text-[10px] uppercase tracking-wider',
            data.dimmed ? 'text-muted-foreground/50' : 'text-muted-foreground',
          )}
        >
          {kind}
        </div>
        {data.description && (
          <div
            className={cn(
              'text-[10px] truncate mt-0.5',
              data.dimmed ? 'text-muted-foreground/30' : 'text-muted-foreground/70',
            )}
          >
            {data.description}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-zinc-400" />
    </div>
  );
});
