import type { EventModelData, ElementDef } from '../types.js';

// ── Options ──────────────────────────────────────────────────────

export interface MermaidOptions {
  /** Diagram type: 'flowchart' (default) or 'sequence' */
  mode?: 'flowchart' | 'sequence';
  /** Direction for flowchart: 'LR' (default) or 'TB' */
  direction?: 'LR' | 'TB';
  /** Filter to a specific slice */
  slice?: string;
  /** Filter to a specific sequence (sequence mode only) */
  sequence?: string;
}

// ── Icons per element kind ───────────────────────────────────────

/** Element kind → the icon its label starts with. */
interface KindIcons {
  readonly [kind: string]: string;
}

const KIND_ICONS: KindIcons = {
  command: '📋',
  event: '⚡',
  aggregate: '🔷',
  readModel: '📊',
  screen: '🖥️',
  automation: '⚙️',
  external: '🌐',
  saga: '🔄',
};

// ── Main generator ──────────────────────────────────────────────

export function generateMermaid(model: EventModelData, options?: MermaidOptions): string {
  const mode = options?.mode ?? 'flowchart';

  if (mode === 'sequence') {
    return generateSequenceDiagrams(model, options);
  }

  return generateFlowchart(model, options);
}

// ══════════════════════════════════════════════════════════════════
// FLOWCHART MODE
// ══════════════════════════════════════════════════════════════════

function generateFlowchart(model: EventModelData, options?: MermaidOptions): string {
  const direction = options?.direction ?? 'LR';
  const lines: string[] = [];

  lines.push(`flowchart ${direction}`);
  lines.push('');

  // Style classes
  lines.push('  %% Element kind styles');
  lines.push('  classDef command fill:#3b82f6,stroke:#1d4ed8,color:#fff');
  lines.push('  classDef event fill:#f59e0b,stroke:#d97706,color:#fff');
  lines.push('  classDef aggregate fill:#8b5cf6,stroke:#6d28d9,color:#fff');
  lines.push('  classDef readModel fill:#10b981,stroke:#059669,color:#fff');
  lines.push('  classDef screen fill:#06b6d4,stroke:#0891b2,color:#fff');
  lines.push('  classDef automation fill:#6b7280,stroke:#4b5563,color:#fff');
  lines.push('  classDef external fill:#ef4444,stroke:#dc2626,color:#fff');
  lines.push('  classDef saga fill:#ec4899,stroke:#db2777,color:#fff');
  lines.push('');

  // Determine which slices to render
  const slices = options?.slice
    ? model.slices.filter((s) => s.name === options.slice)
    : model.slices;

  // Collect all elements that appear in slices
  const slicedElements = new Set<string>();

  for (const slice of slices) {
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

    const subgraphId = sanitizeId(slice.name);
    lines.push(`  subgraph ${subgraphId}["${slice.name}"]`);

    for (const name of allRefs) {
      const el = model.elements.get(name);
      if (!el) continue;
      slicedElements.add(name);
      lines.push(`    ${renderNode(name, el)}`);
    }

    lines.push('  end');
    lines.push('');
  }

  // Render ungrouped elements (not in any slice)
  if (!options?.slice) {
    const ungrouped: string[] = [];
    for (const [name, el] of model.elements) {
      if (!slicedElements.has(name)) {
        ungrouped.push(`  ${renderNode(name, el)}`);
      }
    }
    if (ungrouped.length > 0) {
      lines.push('  subgraph Ungrouped["Other"]');
      lines.push(...ungrouped);
      lines.push('  end');
      lines.push('');
    }
  }

  // Build edges from element references
  lines.push('  %% Relationships');
  const edges = buildEdges(model, slicedElements, !!options?.slice);
  for (const edge of edges) {
    lines.push(`  ${edge}`);
  }

  return lines.join('\n');
}

// ── Node rendering ────────────────────────────────────────────

function renderNode(name: string, el: ElementDef): string {
  const id = sanitizeId(name);
  const icon = KIND_ICONS[el.kind] ?? '';
  const label = `${icon} ${name}`;

  switch (el.kind) {
    case 'aggregate':
      return `${id}{{"${label}"}}:::aggregate`;
    case 'readModel':
      return `${id}(["${label}"]):::readModel`;
    case 'external':
      return `${id}[["${label}"]]:::external`;
    case 'saga':
      return `${id}(["${label}"]):::saga`;
    case 'screen':
      return `${id}["${label}"]:::screen`;
    case 'automation':
      return `${id}["${label}"]:::automation`;
    case 'event':
      return `${id}["${label}"]:::event`;
    case 'command':
    default:
      return `${id}["${label}"]:::command`;
  }
}

// ── Edge building ─────────────────────────────────────────────

function buildEdges(
  model: EventModelData,
  relevantElements: Set<string>,
  filtered: boolean,
): string[] {
  const edges: string[] = [];
  const seen = new Set<string>();

  function add(from: string, to: string, label?: string) {
    // When filtering by slice, only show edges between relevant elements
    if (filtered) {
      if (!relevantElements.has(from) || !relevantElements.has(to)) return;
    }
    // Both elements must exist in the model
    if (!model.elements.has(from) || !model.elements.has(to)) return;

    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);

    const fromId = sanitizeId(from);
    const toId = sanitizeId(to);
    if (label) {
      edges.push(`${fromId} -- "${label}" --> ${toId}`);
    } else {
      edges.push(`${fromId} --> ${toId}`);
    }
  }

  for (const el of model.elements.values()) {
    switch (el.kind) {
      case 'aggregate': {
        const agg = el;
        for (const cmd of agg.handles) add(cmd, agg.name, 'handles');
        for (const evt of agg.emits) add(agg.name, evt, 'emits');
        break;
      }
      case 'screen': {
        const scr = el;
        for (const rm of scr.displays) add(rm, scr.name, 'displays');
        for (const cmd of scr.triggers) add(scr.name, cmd, 'triggers');
        break;
      }
      case 'external': {
        const ext = el;
        for (const cmd of ext.receives) add(cmd, ext.name, 'receives');
        for (const evt of ext.emits) add(ext.name, evt, 'emits');
        break;
      }
      case 'readModel': {
        const rm = el;
        for (const evt of rm.from) add(evt, rm.name, 'projects');
        break;
      }
      case 'automation': {
        const auto = el;
        add(auto.on, auto.name, 'on');
        const triggers = Array.isArray(auto.triggers) ? auto.triggers : [auto.triggers];
        for (const cmd of triggers) add(auto.name, cmd, 'triggers');
        break;
      }
      case 'saga': {
        const saga = el;
        for (const evt of saga.on) add(evt, saga.name, 'listens');
        const triggers = Array.isArray(saga.triggers) ? saga.triggers : [saga.triggers];
        for (const cmd of triggers) add(saga.name, cmd, 'triggers');
        break;
      }
    }
  }

  return edges;
}

// ══════════════════════════════════════════════════════════════════
// SEQUENCE MODE
// ══════════════════════════════════════════════════════════════════

function generateSequenceDiagrams(model: EventModelData, options?: MermaidOptions): string {
  const sequences = options?.sequence
    ? model.sequences.filter((s) => s.name === options.sequence)
    : model.sequences;

  if (sequences.length === 0) {
    return '%% No sequences found\n';
  }

  const sections: string[] = [];

  for (const seq of sequences) {
    const lines: string[] = [];

    lines.push(`%% ── ${seq.name} ──`);
    lines.push('sequenceDiagram');

    // Collect unique participants in order
    const participantOrder: string[] = [];
    const participantSet = new Set<string>();

    for (const stepName of seq.steps) {
      if (!participantSet.has(stepName)) {
        participantSet.add(stepName);
        participantOrder.push(stepName);
      }
    }

    // Render participants with kind icons
    const idMap = new Map<string, string>();
    const usedIds = new Set<string>();

    for (const name of participantOrder) {
      const el = model.elements.get(name);
      const kind = el?.kind ?? 'command';
      const icon = KIND_ICONS[kind] ?? '';
      const id = uniqueId(abbreviate(name), usedIds);
      idMap.set(name, id);
      lines.push(`    participant ${id} as ${icon} ${name}<br/>‹${kind}›`);
    }

    lines.push('');

    // Render steps as arrows
    for (let i = 0; i < seq.steps.length - 1; i++) {
      const from = seq.steps[i];
      const to = seq.steps[i + 1];
      const fromId = idMap.get(from);
      const toId = idMap.get(to);
      if (!fromId || !toId) continue;

      const toEl = model.elements.get(to);
      const label = toEl?.kind ?? '';
      lines.push(`    ${fromId}->>${toId}: ${label}`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

// ── Helpers ─────────────────────────────────────────────────────

function sanitizeId(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function abbreviate(name: string): string {
  const uppers = name.replace(/[^A-Z]/g, '');
  if (uppers.length >= 2) return uppers;
  return sanitizeId(name).slice(0, 8);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  const id = `${base}${i}`;
  used.add(id);
  return id;
}
