import { ReactFlow, Background, Controls, type NodeTypes } from '@xyflow/react';
import { useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { SubdomainNode } from '@/components/graph/subdomain-node';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { buildContextMapGraph } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';

const nodeTypes: NodeTypes = {
  subdomain: SubdomainNode,
};

export function ContextMapView() {
  const graph = useDomainStore((s) => s.graph);

  const { nodes, edges } = useMemo(() => {
    if (!graph?.strategic) return { nodes: [], edges: [] };
    return buildContextMapGraph(graph);
  }, [graph]);

  if (!graph?.strategic) {
    return (
      <div
        className="flex h-full items-center justify-center text-muted-foreground"
        data-testid="context-map-view"
      >
        <p>No strategic model loaded. Include strategic data in your JSON.</p>
      </div>
    );
  }

  const relationships = graph.strategic.contextMap;

  return (
    <div className="flex h-full flex-col" data-testid="context-map-view">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {relationships.length > 0 && (
        <div className="border-t">
          <ScrollArea className="max-h-48">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                  <th className="px-4 py-2">Upstream</th>
                  <th className="px-4 py-2">Downstream</th>
                  <th className="px-4 py-2">Relationship</th>
                  <th className="px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {relationships.map((rel, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-4 py-1.5 font-medium">{rel.upstream}</td>
                    <td className="px-4 py-1.5 font-medium">{rel.downstream}</td>
                    <td className="px-4 py-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {rel.relationship}
                      </Badge>
                    </td>
                    <td className="px-4 py-1.5 text-muted-foreground">{rel.description ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
