import type {
  EventModelData,
  ElementKind,
  AggregateDef,
  ScreenDef,
  ExternalDef,
  AutomationDef,
  SagaDef,
  ReadModelDef,
  SourceRef,
} from '../types.js';

// ── React Flow types (minimal, no runtime dependency) ─────

export interface RFNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    kind: ElementKind;
    description?: string;
    slices: string[];
    fields?: Record<string, string>;
    invariants?: string[];
    source?: SourceRef;
  };
  parentId?: string;
  extent?: 'parent';
  style?: Record<string, string | number>;
}

export interface RFEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type?: string;
  animated?: boolean;
  style?: Record<string, string | number>;
}

export interface ReactFlowGraph {
  nodes: RFNode[];
  edges: RFEdge[];
}

export interface ReactFlowOptions {
  /** Filter to a specific slice */
  slice?: string;
  /** Layout direction: 'LR' (default) or 'TB' */
  direction?: 'LR' | 'TB';
  /** Include slice group nodes */
  groupBySlice?: boolean;
}

// ── Kind metadata ─────────────────────────────────────────

const KIND_COLORS: Record<ElementKind, string> = {
  command: '#3b82f6',
  event: '#f59e0b',
  aggregate: '#8b5cf6',
  readModel: '#10b981',
  screen: '#06b6d4',
  automation: '#6b7280',
  external: '#ef4444',
  saga: '#ec4899',
};

const KIND_ICONS: Record<ElementKind, string> = {
  command: '📋',
  event: '⚡',
  aggregate: '🔷',
  readModel: '📊',
  screen: '🖥️',
  automation: '⚙️',
  external: '🌐',
  saga: '🔄',
};

// ── Main generator ────────────────────────────────────────

export function generateReactFlowGraph(
  model: EventModelData,
  options?: ReactFlowOptions,
): ReactFlowGraph {
  const groupBySlice = options?.groupBySlice ?? true;

  // Build element-to-slices mapping
  const elementSlices = new Map<string, string[]>();
  for (const slice of model.slices) {
    const allRefs = [
      ...slice.commands,
      ...slice.events,
      ...slice.readModels,
      ...slice.automations,
      ...slice.aggregates,
      ...slice.screens,
      ...slice.externals,
      ...slice.sagas,
    ];
    for (const ref of allRefs) {
      const existing = elementSlices.get(ref) ?? [];
      existing.push(slice.name);
      elementSlices.set(ref, existing);
    }
  }

  // Determine which elements to include
  const filteredSlices = options?.slice
    ? model.slices.filter((s) => s.name === options.slice)
    : model.slices;

  const includedElements = new Set<string>();

  if (options?.slice) {
    // Only elements in the filtered slice
    for (const slice of filteredSlices) {
      const allRefs = [
        ...slice.commands,
        ...slice.events,
        ...slice.readModels,
        ...slice.automations,
        ...slice.aggregates,
        ...slice.screens,
        ...slice.externals,
        ...slice.sagas,
      ];
      for (const ref of allRefs) includedElements.add(ref);
    }
  } else {
    // All elements
    for (const name of model.elements.keys()) includedElements.add(name);
  }

  const nodes: RFNode[] = [];
  const edges: RFEdge[] = [];

  // Create slice group nodes
  if (groupBySlice) {
    for (const slice of filteredSlices) {
      nodes.push({
        id: `slice:${sanitizeId(slice.name)}`,
        type: 'group',
        position: { x: 0, y: 0 },
        data: {
          label: slice.name,
          kind: 'command' as ElementKind, // placeholder
          slices: [],
        },
        style: {
          backgroundColor: 'rgba(100, 116, 139, 0.08)',
          borderRadius: 8,
          border: '1px dashed #94a3b8',
          padding: 20,
        },
      });
    }
  }

  // Create element nodes
  for (const [name, el] of model.elements) {
    if (!includedElements.has(name)) continue;

    const slices = elementSlices.get(name) ?? [];
    const node: RFNode = {
      id: sanitizeId(name),
      type: 'evflowNode',
      position: { x: 0, y: 0 },
      data: {
        label: `${KIND_ICONS[el.kind]} ${name}`,
        kind: el.kind,
        description: el.description,
        slices,
      },
    };

    // Add kind-specific data
    if ('fields' in el) {
      node.data.fields = el.fields as Record<string, string>;
    }
    if (el.kind === 'aggregate') {
      node.data.invariants = (el as AggregateDef).invariants;
    }
    if (el.source) {
      node.data.source = el.source;
    }

    // Assign to slice group if single-slice and grouping enabled
    if (groupBySlice && slices.length === 1) {
      node.parentId = `slice:${sanitizeId(slices[0])}`;
      node.extent = 'parent';
    }

    nodes.push(node);
  }

  // Build edges
  const seenEdges = new Set<string>();

  function addEdge(from: string, to: string, label: string) {
    if (!includedElements.has(from) || !includedElements.has(to)) return;
    if (!model.elements.has(from) || !model.elements.has(to)) return;

    const key = `${from}->${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);

    const toEl = model.elements.get(to);
    edges.push({
      id: `e-${sanitizeId(from)}-${sanitizeId(to)}`,
      source: sanitizeId(from),
      target: sanitizeId(to),
      label,
      type: 'smoothstep',
      animated: toEl?.kind === 'event',
      interactionWidth: 20,
      style: {
        stroke: toEl ? KIND_COLORS[toEl.kind] : '#94a3b8',
      },
    });
  }

  for (const el of model.elements.values()) {
    if (!includedElements.has(el.name)) continue;

    switch (el.kind) {
      case 'aggregate': {
        const agg = el as AggregateDef;
        for (const cmd of agg.handles) addEdge(cmd, agg.name, 'handles');
        for (const evt of agg.emits) addEdge(agg.name, evt, 'emits');
        break;
      }
      case 'screen': {
        const scr = el as ScreenDef;
        for (const rm of scr.displays) addEdge(rm, scr.name, 'displays');
        for (const cmd of scr.triggers) addEdge(scr.name, cmd, 'triggers');
        break;
      }
      case 'external': {
        const ext = el as ExternalDef;
        for (const cmd of ext.receives) addEdge(cmd, ext.name, 'receives');
        for (const evt of ext.emits) addEdge(ext.name, evt, 'emits');
        break;
      }
      case 'readModel': {
        const rm = el as ReadModelDef;
        for (const evt of rm.from) addEdge(evt, rm.name, 'projects');
        break;
      }
      case 'automation': {
        const auto = el as AutomationDef;
        addEdge(auto.on, auto.name, 'on');
        const triggers = Array.isArray(auto.triggers) ? auto.triggers : [auto.triggers];
        for (const cmd of triggers) addEdge(auto.name, cmd, 'triggers');
        break;
      }
      case 'saga': {
        const saga = el as SagaDef;
        for (const evt of saga.on) addEdge(evt, saga.name, 'listens');
        const triggers = Array.isArray(saga.triggers) ? saga.triggers : [saga.triggers];
        for (const cmd of triggers) addEdge(saga.name, cmd, 'triggers');
        break;
      }
    }
  }

  return { nodes, edges };
}

// ── Helpers ───────────────────────────────────────────────

function sanitizeId(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Kind color palette — useful for viewer styling */
export const EVFLOW_COLORS = KIND_COLORS;
export const EVFLOW_ICONS = KIND_ICONS;
