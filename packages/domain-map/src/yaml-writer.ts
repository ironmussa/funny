import { parseDocument } from 'yaml';

import type { SyncAction } from './types.js';

/**
 * Apply code-to-yaml sync actions to a YAML document string.
 * Uses parseDocument() for comment-preserving round-trip.
 */
export function applyActionsToYAML(yamlContent: string, actions: SyncAction[]): string {
  const doc = parseDocument(yamlContent);

  for (const action of actions) {
    if (action.direction !== 'code-to-yaml') continue;

    switch (action.kind) {
      case 'add-subdomain':
        addSubdomain(doc, action);
        break;
      case 'add-events':
        addEvents(doc, action);
        break;
      case 'add-context-map':
        addContextMapEntry(doc, action);
        break;
    }
  }

  return doc.toString();
}

// ── Handlers ────────────────────────────────────────────────────

function addSubdomain(doc: ReturnType<typeof parseDocument>, action: SyncAction): void {
  const { name, type, boundedContext } = action.payload as {
    name: string;
    type: string;
    boundedContext: string;
  };

  const subdomains = doc.get('subdomains', true) as any;
  if (!subdomains || subdomains.has(name)) return;

  const entry = doc.createNode({
    type,
    'bounded-context': boundedContext,
    description: `TODO: Add description for ${name}`,
  });

  subdomains.set(doc.createNode(name), entry);
}

function addEvents(doc: ReturnType<typeof parseDocument>, action: SyncAction): void {
  const { subdomain, events } = action.payload as {
    subdomain: string;
    events: string[];
  };

  const subdomains = doc.get('subdomains', true) as any;
  if (!subdomains) return;

  const sdNode = subdomains.get(subdomain, true) as any;
  if (!sdNode) return;

  let publishes = sdNode.get('publishes', true);
  if (!publishes) {
    sdNode.set('publishes', doc.createNode(events));
    return;
  }

  // Append new events to existing array
  for (const event of events) {
    (publishes as any).add(doc.createNode(event));
  }
}

function addContextMapEntry(doc: ReturnType<typeof parseDocument>, action: SyncAction): void {
  const { upstream, downstream, relationship } = action.payload as {
    upstream: string;
    downstream: string;
    relationship: string;
  };

  let contextMap = doc.get('context-map', true) as any;
  if (!contextMap) {
    doc.set('context-map', doc.createNode([]));
    contextMap = doc.get('context-map', true) as any;
  }

  const entry = doc.createNode({
    upstream,
    downstream,
    relationship,
    description: `TODO: Describe ${upstream} → ${downstream} relationship`,
  });

  contextMap.add(entry);
}
