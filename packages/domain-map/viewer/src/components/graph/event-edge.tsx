import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

import type { EventEdgeData } from '@/lib/transform';

export function EventEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, id, data } = props;
  const edgeData = data as unknown as EventEdgeData | undefined;
  const events = edgeData?.events ?? [];

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const label = events.length <= 2 ? events.join(', ') : `${events.length} events`;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1.5 }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto rounded border border-border/50 bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
