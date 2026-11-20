import dagre from '@dagrejs/dagre';

import type { RFNode, RFEdge } from '../../../src/generators/react-flow';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const GROUP_PADDING = 40;

/**
 * Apply Dagre auto-layout to React Flow nodes/edges.
 * Returns new nodes with computed positions.
 */
export function applyDagreLayout(
  nodes: RFNode[],
  edges: RFEdge[],
  direction: 'LR' | 'TB' = 'LR',
): RFNode[] {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 50,
    ranksep: 80,
    marginx: 20,
    marginy: 20,
  });

  // Add nodes
  for (const node of nodes) {
    if (node.type === 'group') {
      g.setNode(node.id, { width: 300, height: 200 });
    } else {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
      if (node.parentId) {
        g.setParent(node.id, node.parentId);
      }
    }
  }

  // Add edges (only between non-group nodes)
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const n = g.node(node.id);
    if (!n) return node;

    const width = node.type === 'group' ? n.width : NODE_WIDTH;
    const height = node.type === 'group' ? n.height : NODE_HEIGHT;

    // If node has a parent, position relative to parent
    let x = n.x - width / 2;
    let y = n.y - height / 2;

    if (node.parentId) {
      const parent = g.node(node.parentId);
      if (parent) {
        x = n.x - parent.x + parent.width / 2 - width / 2;
        y = n.y - parent.y + parent.height / 2 - height / 2;
      }
    }

    return {
      ...node,
      position: { x, y },
      style:
        node.type === 'group'
          ? {
              ...node.style,
              width: n.width + GROUP_PADDING,
              height: n.height + GROUP_PADDING,
            }
          : node.style,
    };
  });
}
