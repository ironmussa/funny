import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

import { DBML_NODE_WIDTH, tableNodeHeightFromData, type DbmlTableNodeData } from './schema-node';

/** Apply Dagre auto-layout to DBML table nodes and relationship edges. */
export function applyDbmlDagreLayout(
  nodes: Node<DbmlTableNodeData>[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR',
): Node<DbmlTableNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 60,
    ranksep: 90,
    marginx: 24,
    marginy: 24,
  });

  for (const node of nodes) {
    g.setNode(node.id, {
      width: DBML_NODE_WIDTH,
      height: tableNodeHeightFromData(node.data),
    });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const n = g.node(node.id);
    if (!n) return node;
    const height = tableNodeHeightFromData(node.data);
    return {
      ...node,
      position: {
        x: n.x - DBML_NODE_WIDTH / 2,
        y: n.y - height / 2,
      },
    };
  });
}
