import type { Edge, Node } from '@xyflow/react';

import { applyDbmlDagreLayout } from './dbml-flow-layout';
import { parseDbml } from './dbml-model';
import { DBML_TABLE_NODE_TYPE, type DbmlTableNodeData } from './schema-node';

export type DbmlFlowGraph = {
  nodes: Node<DbmlTableNodeData>[];
  edges: Edge[];
};

/** Parse DBML and build a laid-out React Flow graph (tables + FK edges). */
export function dbmlToFlow(source: string): DbmlFlowGraph {
  const model = parseDbml(source);

  const nodes: Node<DbmlTableNodeData>[] = model.tables.map((table) => ({
    id: table.name,
    type: DBML_TABLE_NODE_TYPE,
    position: { x: 0, y: 0 },
    data: {
      label: table.name,
      headerColor: table.headerColor,
      note: table.note,
      schema: table.columns.map((col) => ({
        title: col.name,
        type: col.type,
        pk: col.pk,
        unique: col.unique,
        notNull: col.notNull,
        note: col.note,
        fk: col.fk,
        fkTarget: col.fkTarget,
      })),
    },
  }));

  const edges: Edge[] = model.refs.map((ref, index) => ({
    id: `ref-${index}-${ref.sourceTable}-${ref.sourceColumn}-${ref.targetTable}-${ref.targetColumn}`,
    source: ref.sourceTable,
    target: ref.targetTable,
    sourceHandle: ref.sourceColumn,
    targetHandle: ref.targetColumn,
    type: 'smoothstep',
    style: { stroke: 'hsl(var(--foreground))', strokeWidth: 1.5 },
  }));

  const layoutNodes = applyDbmlDagreLayout(nodes, edges, 'LR');

  return { nodes: layoutNodes, edges };
}
