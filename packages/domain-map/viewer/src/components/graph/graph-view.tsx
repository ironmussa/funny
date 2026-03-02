import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import { useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { buildSubdomainGraph } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';

import { EventEdge } from './event-edge';
import { SubdomainNode } from './subdomain-node';

const nodeTypes: NodeTypes = {
  subdomain: SubdomainNode,
};

const edgeTypes: EdgeTypes = {
  event: EventEdge,
};

export function GraphView() {
  const graph = useDomainStore((s) => s.graph);
  const subdomainFilter = useDomainStore((s) => s.subdomainFilter);
  const typeFilter = useDomainStore((s) => s.typeFilter);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [], edges: [] };

    // Filter subdomains by type
    const visible = new Set<string>();
    for (const sd of subdomainFilter) {
      const nodeKeys = graph.subdomains[sd] ?? [];
      const firstNode = nodeKeys[0] ? graph.nodes[nodeKeys[0]] : null;
      const sdType = firstNode?.subdomainType ?? graph.strategic?.subdomains[sd]?.type ?? 'generic';
      if (typeFilter.has(sdType as 'core' | 'supporting' | 'generic')) {
        visible.add(sd);
      }
    }

    return buildSubdomainGraph(graph, visible);
  }, [graph, subdomainFilter, typeFilter]);

  if (!graph) return null;

  return (
    <div className="h-full w-full" data-testid="graph-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor={(node) => {
            const data = node.data as Record<string, unknown>;
            const type = data?.subdomainType as string;
            if (type === 'core') return '#10b981';
            if (type === 'supporting') return '#3b82f6';
            return '#9ca3af';
          }}
          className="!bg-background/80"
        />
      </ReactFlow>
    </div>
  );
}
