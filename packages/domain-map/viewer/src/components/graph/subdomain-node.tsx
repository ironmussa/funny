import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileText, Zap } from 'lucide-react';
import { memo } from 'react';

import { Badge } from '@/components/ui/badge';
import type { SubdomainNodeData } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';

export const SubdomainNode = memo(function SubdomainNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SubdomainNodeData;
  const selected = useDomainStore((s) => s.selectedSubdomain);
  const select = useDomainStore((s) => s.selectSubdomain);
  const isSelected = selected === id;

  const bgColors: Record<string, string> = {
    core: 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40',
    supporting: 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40',
    generic: 'border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-900/40',
  };

  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div
        data-testid={`node-${id}`}
        className={`cursor-pointer rounded-lg border-2 px-4 py-3 shadow-sm transition-shadow hover:shadow-md ${
          bgColors[nodeData.subdomainType] ?? bgColors.generic
        } ${isSelected ? 'ring-2 ring-primary' : ''}`}
        onClick={() => select(isSelected ? null : id)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{nodeData.label}</span>
          <Badge variant={nodeData.subdomainType} className="text-[10px]">
            {nodeData.subdomainType}
          </Badge>
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {nodeData.fileCount} files
          </span>
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {nodeData.eventCount} events
          </span>
        </div>
        {nodeData.team && (
          <div className="mt-1 text-[10px] text-muted-foreground">Team: {nodeData.team}</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </>
  );
});
