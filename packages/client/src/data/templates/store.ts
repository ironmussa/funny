import type { AgentTemplate } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * The session's agent templates: the user's and shared templates in server
 * order, followed by the built-in ones. Templates created in the session go
 * to the top until the next load puts them in server order.
 */
export interface TemplatesData extends EntityStore<AgentTemplate> {
  /** List position of each template; lower comes first. */
  readonly position: Map<string, number>;
  /** Whether a list response has landed in this session. */
  loaded: boolean;
}

export function getTemplatesData(layer: DataLayer = getDataLayer()): TemplatesData {
  return layer.own('agent-templates', () => {
    const data: TemplatesData = Object.assign(
      createEntityStore<AgentTemplate>(layer, 'agent-templates'),
      { position: new Map<string, number>(), loaded: false },
    );
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

export function compareTemplates(data: TemplatesData) {
  const position = (t: AgentTemplate) => data.position.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  return (a: AgentTemplate, b: AgentTemplate) => position(a) - position(b);
}

/** Put templates at the top of the list (newest first). */
export function prependPositions(data: TemplatesData, ids: readonly string[]): void {
  let top = Math.min(0, ...data.position.values());
  for (const id of [...ids].reverse()) data.position.set(id, --top);
}
