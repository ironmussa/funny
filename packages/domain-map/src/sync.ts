import type { DomainGraph, StrategicModel, SyncAction } from './types.js';

// ── Code → YAML ─────────────────────────────────────────────────

/**
 * Compute sync actions to update domain.yaml from code annotations.
 * Pure function — no I/O.
 */
export function computeCodeToYamlActions(
  graph: DomainGraph,
  strategic: StrategicModel,
): SyncAction[] {
  const actions: SyncAction[] = [];

  // 1. Subdomains in code not defined in YAML
  for (const sdName of graph.subdomains.keys()) {
    if (strategic.subdomains.has(sdName)) continue;
    if (strategic.sharedKernel?.name === sdName) continue;

    // Infer type from annotations if available
    const nodeKeys = graph.subdomains.get(sdName) ?? [];
    let inferredType = 'supporting';
    for (const key of nodeKeys) {
      const node = graph.nodes.get(key);
      if (node?.subdomainType) {
        inferredType = node.subdomainType;
        break;
      }
    }

    const bc = toPascalCase(sdName);

    actions.push({
      direction: 'code-to-yaml',
      kind: 'add-subdomain',
      message: `New subdomain "${sdName}" found in code → add to YAML as ${inferredType} with BC "${bc}"`,
      target: `subdomains.${sdName}`,
      payload: { name: sdName, type: inferredType, boundedContext: bc },
    });
  }

  // 2. Events emitted in code but not in YAML publishes
  for (const [sdName, sdDef] of strategic.subdomains) {
    const nodeKeys = graph.subdomains.get(sdName) ?? [];
    const yamlEvents = new Set(sdDef.publishes);
    const codeEvents = new Set<string>();

    for (const key of nodeKeys) {
      const node = graph.nodes.get(key);
      if (!node) continue;
      for (const e of node.emits) codeEvents.add(e);
    }

    const missing = [...codeEvents].filter((e) => !yamlEvents.has(e));
    if (missing.length > 0) {
      actions.push({
        direction: 'code-to-yaml',
        kind: 'add-events',
        message: `${missing.length} events emitted in "${sdName}" not in YAML publishes → ${missing.join(', ')}`,
        target: `subdomains.${sdName}.publishes`,
        payload: { subdomain: sdName, events: missing },
      });
    }
  }

  // 3. Cross-subdomain event flows not in context-map
  const bcForSubdomain = new Map<string, string>();
  for (const [sdName, sdDef] of strategic.subdomains) {
    bcForSubdomain.set(sdName, sdDef.boundedContext);
  }

  // Build existing relationship set for fast lookup
  const existingRels = new Set<string>();
  for (const rel of strategic.contextMap) {
    existingRels.add(`${rel.upstream}->${rel.downstream}`);
    // Partnership is bidirectional
    if (rel.relationship === 'partnership') {
      existingRels.add(`${rel.downstream}->${rel.upstream}`);
    }
  }

  // Check cross-subdomain event consumption
  const suggestedRels = new Map<string, { upstream: string; downstream: string }>();

  for (const [, node] of graph.nodes) {
    if (node.consumes.length === 0) continue;
    const consumerBC = bcForSubdomain.get(node.subdomain);
    if (!consumerBC) continue;

    for (const event of node.consumes) {
      // Find who emits this event
      for (const [, emitter] of graph.nodes) {
        if (!emitter.emits.includes(event)) continue;
        const emitterBC = bcForSubdomain.get(emitter.subdomain);
        if (!emitterBC || emitterBC === consumerBC) continue;

        const relKey = `${emitterBC}->${consumerBC}`;
        if (!existingRels.has(relKey) && !suggestedRels.has(relKey)) {
          suggestedRels.set(relKey, { upstream: emitterBC, downstream: consumerBC });
        }
      }
    }
  }

  for (const [, rel] of suggestedRels) {
    actions.push({
      direction: 'code-to-yaml',
      kind: 'add-context-map',
      message: `Cross-subdomain event flow: ${rel.upstream} → ${rel.downstream} not in context-map`,
      target: 'context-map',
      payload: {
        upstream: rel.upstream,
        downstream: rel.downstream,
        relationship: 'customer-supplier',
      },
    });
  }

  return actions;
}

// ── YAML → Code ─────────────────────────────────────────────────

/**
 * Compute sync actions to update code annotations from domain.yaml.
 * Pure function — no I/O.
 */
export function computeYamlToCodeActions(
  graph: DomainGraph,
  strategic: StrategicModel,
): SyncAction[] {
  const actions: SyncAction[] = [];

  for (const [, node] of graph.nodes) {
    const sdDef = strategic.subdomains.get(node.subdomain);
    if (!sdDef) continue;

    // 1. Subdomain type mismatch or missing
    if (node.subdomainType && node.subdomainType !== sdDef.type) {
      actions.push({
        direction: 'yaml-to-code',
        kind: 'update-subdomain-type',
        message: `"${node.name}" has subdomain-type "${node.subdomainType}" but YAML says "${sdDef.type}" → update annotation`,
        target: node.filePath,
        payload: { name: node.name, oldType: node.subdomainType, newType: sdDef.type },
      });
    } else if (!node.subdomainType) {
      actions.push({
        direction: 'yaml-to-code',
        kind: 'update-subdomain-type',
        message: `"${node.name}" missing subdomain-type → add "${sdDef.type}" from YAML`,
        target: node.filePath,
        payload: { name: node.name, oldType: null, newType: sdDef.type },
      });
    }

    // 2. Missing context tag
    if (!node.context) {
      actions.push({
        direction: 'yaml-to-code',
        kind: 'add-context',
        message: `"${node.name}" missing context → add "${sdDef.boundedContext}" from YAML`,
        target: node.filePath,
        payload: { name: node.name, context: sdDef.boundedContext },
      });
    }
  }

  // 3. Subdomains in YAML with no code annotations
  const annotatedSubdomains = new Set(graph.subdomains.keys());
  for (const [sdName] of strategic.subdomains) {
    if (!annotatedSubdomains.has(sdName)) {
      actions.push({
        direction: 'yaml-to-code',
        kind: 'notify-unannotated',
        message: `Subdomain "${sdName}" defined in YAML but has no @domain annotations in code`,
        target: sdName,
        payload: { subdomain: sdName },
      });
    }
  }

  return actions;
}

// ── Helpers ──────────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
