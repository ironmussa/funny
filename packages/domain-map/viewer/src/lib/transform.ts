import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

import type { SerializedGraph, DomainNode, EventInfo, SubdomainType } from '@/types/domain';

// ── Subdomain-level graph for React Flow ────────────────────────

export interface SubdomainNodeData {
  label: string;
  subdomainType: SubdomainType;
  fileCount: number;
  eventCount: number;
  boundedContext?: string;
  team?: string;
  [key: string]: unknown;
}

export interface EventEdgeData {
  events: string[];
  [key: string]: unknown;
}

export function buildSubdomainGraph(
  graph: SerializedGraph,
  visibleSubdomains: Set<string>,
): { nodes: Node<SubdomainNodeData>[]; edges: Edge<EventEdgeData>[] } {
  const nodes: Node<SubdomainNodeData>[] = [];
  const edgeMap = new Map<string, string[]>();

  // Build nodes
  for (const [sdName, nodeKeys] of Object.entries(graph.subdomains)) {
    if (!visibleSubdomains.has(sdName)) continue;

    const sdNodes = nodeKeys.map((k) => graph.nodes[k]).filter(Boolean);

    const allEmits = new Set<string>();
    const allConsumes = new Set<string>();
    for (const n of sdNodes) {
      n.emits.forEach((e) => allEmits.add(e));
      n.consumes.forEach((e) => allConsumes.add(e));
    }

    const strategic = graph.strategic?.subdomains[sdName];
    const team = graph.strategic?.teams.find((t) =>
      t.owns.includes(strategic?.boundedContext ?? ''),
    );

    nodes.push({
      id: sdName,
      type: 'subdomain',
      position: { x: 0, y: 0 },
      data: {
        label: sdName,
        subdomainType: (sdNodes[0]?.subdomainType ?? strategic?.type ?? 'generic') as SubdomainType,
        fileCount: sdNodes.length,
        eventCount: allEmits.size + allConsumes.size,
        boundedContext: strategic?.boundedContext,
        team: team?.name,
      },
    });

    // Build edges by matching emits → consumes across subdomains
    for (const evt of allEmits) {
      for (const [otherSd, otherKeys] of Object.entries(graph.subdomains)) {
        if (otherSd === sdName || !visibleSubdomains.has(otherSd)) continue;
        const otherNodes = otherKeys.map((k) => graph.nodes[k]).filter(Boolean);
        const consumed = otherNodes.some((n) => n.consumes.includes(evt));
        if (consumed) {
          const edgeKey = `${sdName}→${otherSd}`;
          if (!edgeMap.has(edgeKey)) edgeMap.set(edgeKey, []);
          edgeMap.get(edgeKey)!.push(evt);
        }
      }
    }
  }

  // Convert edge map to React Flow edges
  const edges: Edge<EventEdgeData>[] = [];
  for (const [key, events] of edgeMap) {
    const [source, target] = key.split('→');
    edges.push({
      id: key,
      source,
      target,
      type: 'event',
      data: { events },
    });
  }

  // Apply dagre layout
  return applyDagreLayout(nodes, edges);
}

function applyDagreLayout<N extends Record<string, unknown>, E extends Record<string, unknown>>(
  nodes: Node<N>[],
  edges: Edge<E>[],
): { nodes: Node<N>[]; edges: Edge<E>[] } {
  if (nodes.length === 0) return { nodes, edges };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });

  for (const node of nodes) {
    g.setNode(node.id, { width: 220, height: 100 });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positioned = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - 110, y: pos.y - 50 },
    };
  });

  return { nodes: positioned, edges };
}

// ── Event adjacency analysis ────────────────────────────────────

export function buildEventInfo(graph: SerializedGraph): EventInfo[] {
  const eventMap = new Map<
    string,
    {
      emitters: { name: string; subdomain: string }[];
      consumers: { name: string; subdomain: string }[];
    }
  >();

  for (const node of Object.values(graph.nodes)) {
    for (const evt of node.emits) {
      if (!eventMap.has(evt)) eventMap.set(evt, { emitters: [], consumers: [] });
      eventMap.get(evt)!.emitters.push({ name: node.name, subdomain: node.subdomain });
    }
    for (const evt of node.consumes) {
      if (!eventMap.has(evt)) eventMap.set(evt, { emitters: [], consumers: [] });
      eventMap.get(evt)!.consumers.push({ name: node.name, subdomain: node.subdomain });
    }
    if (node.event) {
      if (!eventMap.has(node.event)) eventMap.set(node.event, { emitters: [], consumers: [] });
    }
  }

  const result: EventInfo[] = [];
  for (const [event, info] of eventMap) {
    const family = event.includes(':') ? event.split(':')[0] : 'other';
    const emitterSds = new Set(info.emitters.map((e) => e.subdomain));
    const consumerSds = new Set(info.consumers.map((c) => c.subdomain));
    const isCross = [...consumerSds].some((sd) => !emitterSds.has(sd));

    result.push({
      event,
      family,
      emitters: info.emitters,
      consumers: info.consumers,
      isCrossSubdomain: isCross,
      isOrphan: info.emitters.length > 0 && info.consumers.length === 0,
      isDeadLetter: info.consumers.length > 0 && info.emitters.length === 0,
    });
  }

  return result.sort((a, b) => a.event.localeCompare(b.event));
}

// ── Context map graph for React Flow ────────────────────────────

export function buildContextMapGraph(graph: SerializedGraph): {
  nodes: Node<SubdomainNodeData>[];
  edges: Edge[];
} {
  if (!graph.strategic) return { nodes: [], edges: [] };

  const nodes: Node<SubdomainNodeData>[] = [];
  const bcToSd = new Map<string, string>();

  for (const [sdName, def] of Object.entries(graph.strategic.subdomains)) {
    bcToSd.set(def.boundedContext, sdName);
    const nodeKeys = graph.subdomains[sdName] ?? [];
    const team = graph.strategic.teams.find((t) => t.owns.includes(def.boundedContext));

    nodes.push({
      id: def.boundedContext,
      type: 'subdomain',
      position: { x: 0, y: 0 },
      data: {
        label: def.boundedContext,
        subdomainType: def.type,
        fileCount: nodeKeys.length,
        eventCount: def.publishes.length,
        team: team?.name,
      },
    });
  }

  const edges: Edge[] = graph.strategic.contextMap.map((rel, i) => ({
    id: `ctx-${i}`,
    source: rel.upstream,
    target: rel.downstream,
    label: abbreviateRelationship(rel.relationship),
    animated: rel.relationship === 'partnership',
    style: rel.relationship === 'separate-ways' ? { strokeDasharray: '5 5' } : undefined,
  }));

  return applyDagreLayout(nodes, edges);
}

const REL_ABBR: Record<string, string> = {
  'customer-supplier': 'C/S',
  partnership: 'Partnership',
  conformist: 'Conformist',
  'published-language': 'PL',
  'anti-corruption-layer': 'ACL',
  'open-host-service': 'OHS',
  'shared-kernel': 'SK',
  'separate-ways': 'SW',
};

function abbreviateRelationship(rel: string): string {
  return REL_ABBR[rel] ?? rel;
}

// ── Subdomain info helper ───────────────────────────────────────

export function getSubdomainNodes(graph: SerializedGraph, subdomain: string): DomainNode[] {
  const keys = graph.subdomains[subdomain] ?? [];
  return keys.map((k) => graph.nodes[k]).filter(Boolean);
}

export function getSubdomainType(graph: SerializedGraph, subdomain: string): SubdomainType {
  const strategic = graph.strategic?.subdomains[subdomain];
  if (strategic) return strategic.type;
  const nodes = getSubdomainNodes(graph, subdomain);
  return (nodes[0]?.subdomainType as SubdomainType) ?? 'generic';
}
