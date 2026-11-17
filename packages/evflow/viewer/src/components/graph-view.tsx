import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from '@xyflow/react';
import { useMemo, useCallback, useEffect, useRef } from 'react';
import '@xyflow/react/dist/style.css';

import { generateReactFlowGraph, EVFLOW_COLORS } from '../../../src/generators/react-flow';
import type { ElementKind } from '../../../src/types';
import { applyDagreLayout } from '../lib/layout';
import { useViewerStore } from '../stores/viewer-store';
import { EvflowNode } from './evflow-node';

const nodeTypes = { evflowNode: EvflowNode };

const miniMapNodeColor = (node: Node) => {
  const kind = node.data?.kind as ElementKind | undefined;
  if (kind && kind in EVFLOW_COLORS) return EVFLOW_COLORS[kind];
  return '#64748b';
};

/**
 * Given a set of node IDs, find all directly connected node IDs via edges.
 */
function getConnectedIds(sourceIds: Set<string>, edges: Edge[]): Set<string> {
  const connected = new Set<string>(sourceIds);
  for (const edge of edges) {
    if (sourceIds.has(edge.source)) connected.add(edge.target);
    if (sourceIds.has(edge.target)) connected.add(edge.source);
  }
  return connected;
}

export function GraphView() {
  const model = useViewerStore((s) => s.model);
  const activeSlice = useViewerStore((s) => s.activeSlice);
  const activeKind = useViewerStore((s) => s.activeKind);
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const selectedNode = useViewerStore((s) => s.selectedNode);
  const selectedEdge = useViewerStore((s) => s.selectedEdge);
  const setSelectedNode = useViewerStore((s) => s.setSelectedNode);
  const setSelectedEdge = useViewerStore((s) => s.setSelectedEdge);

  // Build the base graph — filtered by slice only, NOT by search or kind
  // Search and kind now highlight instead of removing
  const { layoutNodes, layoutEdges, allEdges } = useMemo(() => {
    if (!model)
      return { layoutNodes: [] as Node[], layoutEdges: [] as Edge[], allEdges: [] as Edge[] };

    const graph = generateReactFlowGraph(model, {
      slice: activeSlice ?? undefined,
      groupBySlice: !activeSlice,
    });

    let filteredNodes = graph.nodes;
    let filteredEdges = graph.edges;

    // When NO slice is active and kind filter is set, remove nodes (hard filter)
    if (activeKind && !activeSlice) {
      const matchingIds = new Set(
        filteredNodes.filter((n) => n.data.kind === activeKind).map((n) => n.id),
      );
      filteredNodes = filteredNodes.filter((n) => n.type === 'group' || matchingIds.has(n.id));
      filteredEdges = filteredEdges.filter(
        (e) => matchingIds.has(e.source) || matchingIds.has(e.target),
      );
    }

    // Remove empty group nodes
    const childParentIds = new Set(filteredNodes.filter((n) => n.parentId).map((n) => n.parentId));
    filteredNodes = filteredNodes.filter((n) => n.type !== 'group' || childParentIds.has(n.id));

    const laid = applyDagreLayout(filteredNodes, filteredEdges, 'LR');
    return {
      layoutNodes: laid as Node[],
      layoutEdges: filteredEdges as Edge[],
      allEdges: filteredEdges as Edge[],
    };
  }, [model, activeSlice, activeKind]);

  // Compute highlight sets from selection, search, or kind filter
  const { highlightedNodeIds, highlightedEdgeIds } = useMemo(() => {
    const hasNodeSelection = !!selectedNode;
    const hasEdgeSelection = !!selectedEdge;
    const hasSelection = hasNodeSelection || hasEdgeSelection;
    const hasKindFilter = !!activeKind && !!activeSlice;
    const hasSearch = !!searchQuery;

    if (!hasSelection && !hasKindFilter && !hasSearch) {
      return { highlightedNodeIds: null, highlightedEdgeIds: null };
    }

    // Edge selection: highlight the edge + its source and target nodes
    if (hasEdgeSelection) {
      const edge = allEdges.find((e) => e.id === selectedEdge);
      if (!edge) {
        return { highlightedNodeIds: new Set<string>(), highlightedEdgeIds: new Set<string>() };
      }

      const nodeIds = new Set<string>([edge.source, edge.target]);
      const edgeIds = new Set<string>([edge.id]);

      return { highlightedNodeIds: nodeIds, highlightedEdgeIds: edgeIds };
    }

    let primaryIds = new Set<string>();

    // 1. Node selection: the selected node is the primary
    if (hasNodeSelection) {
      primaryIds.add(selectedNode!);
    }

    // 2. Search: nodes matching the query are primary
    if (hasSearch && !hasNodeSelection) {
      const q = searchQuery.toLowerCase();
      for (const node of layoutNodes) {
        if (node.type === 'group') continue;
        const label = (node.data?.label as string) ?? '';
        const desc = (node.data?.description as string) ?? '';
        if (label.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
          primaryIds.add(node.id);
        }
      }
    }

    // 3. Kind filter within slice: nodes of matching kind are primary
    if (hasKindFilter && !hasNodeSelection && !hasSearch) {
      for (const node of layoutNodes) {
        if (node.type !== 'group' && node.data?.kind === activeKind) {
          primaryIds.add(node.id);
        }
      }
    }

    if (primaryIds.size === 0) {
      // Search/filter matched nothing — dim everything
      return {
        highlightedNodeIds: new Set<string>(),
        highlightedEdgeIds: new Set<string>(),
      };
    }

    // Only expand to connected nodes for node selection, not for search/kind filter
    const highlightIds = hasNodeSelection ? getConnectedIds(primaryIds, allEdges) : primaryIds;

    // Find edges that touch highlighted nodes
    const edgeIds = new Set<string>();
    for (const edge of allEdges) {
      if (hasNodeSelection) {
        // Node selection: show edges between any highlighted nodes
        if (highlightIds.has(edge.source) && highlightIds.has(edge.target)) {
          edgeIds.add(edge.id);
        }
      } else {
        // Search/kind: show edges that connect to a matched node
        if (highlightIds.has(edge.source) || highlightIds.has(edge.target)) {
          edgeIds.add(edge.id);
        }
      }
    }

    return { highlightedNodeIds: highlightIds, highlightedEdgeIds: edgeIds };
  }, [selectedNode, selectedEdge, activeKind, activeSlice, searchQuery, allEdges, layoutNodes]);

  // Apply highlight/dim to nodes
  const styledNodes = useMemo(() => {
    if (!highlightedNodeIds) return layoutNodes;

    return layoutNodes.map((node) => {
      if (node.type === 'group') return node;

      const isHighlighted = highlightedNodeIds.has(node.id);
      return {
        ...node,
        data: {
          ...node.data,
          highlighted: isHighlighted,
          dimmed: !isHighlighted,
        },
      };
    });
  }, [layoutNodes, highlightedNodeIds]);

  // Apply highlight/dim to edges
  const styledEdges = useMemo(() => {
    if (!highlightedEdgeIds) return layoutEdges;

    return layoutEdges.map((edge) => {
      const isHighlighted = highlightedEdgeIds.has(edge.id);
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: isHighlighted ? 1 : 0.1,
          strokeWidth: isHighlighted ? 2.5 : 1,
        },
        labelStyle: isHighlighted ? { opacity: 1, fontWeight: 600 } : { opacity: 0.1 },
      };
    });
  }, [layoutEdges, highlightedEdgeIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(styledNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(styledEdges);
  const { fitView } = useReactFlow();
  // Track previous slice/kind to detect changes (skip initial mount)
  const prevFilterRef = useRef({ activeSlice, activeKind });

  useEffect(() => {
    setNodes(styledNodes);
    setEdges(styledEdges);

    // Fit view when slice or kind filter changes so the viewport
    // adjusts to show the filtered elements.
    const prev = prevFilterRef.current;
    if (prev.activeSlice !== activeSlice || prev.activeKind !== activeKind) {
      prevFilterRef.current = { activeSlice, activeKind };
      // Wait a frame for React Flow to process the new nodes before fitting
      requestAnimationFrame(() => {
        fitView({ padding: 0.15, duration: 300 });
      });
    }
  }, [styledNodes, styledEdges, setNodes, setEdges, activeSlice, activeKind, fitView]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type !== 'group') {
        setSelectedNode(selectedNode === node.id ? null : node.id);
      }
    },
    [setSelectedNode, selectedNode],
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setSelectedEdge(selectedEdge === edge.id ? null : edge.id);
    },
    [setSelectedEdge, selectedEdge],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  if (!model) return null;

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} />
        <Controls className="!rounded-lg !border-zinc-700 !bg-zinc-800 [&>button:hover]:!bg-zinc-700 [&>button]:!border-zinc-700 [&>button]:!bg-zinc-800 [&>button]:!text-zinc-300" />
        <MiniMap
          nodeColor={miniMapNodeColor}
          maskColor="rgba(0, 0, 0, 0.6)"
          className="!rounded-lg !border-zinc-700 !bg-zinc-900"
        />
      </ReactFlow>
    </div>
  );
}
