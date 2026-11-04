import type { Automation, AutomationRun, InboxItem } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * Automations, their run history and the inbox, as three collections:
 * - automations, loaded per project (`replaceWhere` on `projectId`);
 * - runs, loaded per automation while its history is open;
 * - inbox rows (completed/failed runs with their automation and thread),
 *   keyed by run id.
 * `automation:run_*` events are synced writes into whichever are loaded.
 */

/** An inbox item keyed by its run id. */
export type InboxRow = InboxItem & { id: string };

export interface AutomationsData extends EntityStore<Automation> {
  /** List position within a project; created automations go to the top. */
  readonly position: Map<string, number>;
}

export interface RunsData extends EntityStore<AutomationRun> {
  /** Automations whose run history has been loaded in this session. */
  readonly loadedFor: Set<string>;
}

type Disposable = { collection: { cleanup: (options: { dependents: boolean }) => Promise<void> } };

function own<D extends Disposable>(layer: DataLayer, key: string, create: () => D): D {
  return layer.own(key, () => {
    const data = create();
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

export function getAutomationsData(layer: DataLayer = getDataLayer()): AutomationsData {
  return own(layer, 'automations', () =>
    Object.assign(createEntityStore<Automation>(layer, 'automations'), {
      position: new Map<string, number>(),
    }),
  );
}

export function getRunsData(layer: DataLayer = getDataLayer()): RunsData {
  return own(layer, 'automation-runs', () =>
    Object.assign(createEntityStore<AutomationRun>(layer, 'automation-runs'), {
      loadedFor: new Set<string>(),
    }),
  );
}

export function getInboxData(layer: DataLayer = getDataLayer()): EntityStore<InboxRow> {
  return own(layer, 'automation-inbox', () =>
    createEntityStore<InboxRow>(layer, 'automation-inbox'),
  );
}

export function toInboxRow(item: InboxItem): InboxRow {
  return { ...item, id: item.run.id };
}

export function compareAutomations(data: AutomationsData) {
  const position = (a: Automation) => data.position.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  return (a: Automation, b: Automation) => position(a) - position(b);
}

/** Newest first. */
export function compareRuns(a: AutomationRun, b: AutomationRun): number {
  return b.startedAt.localeCompare(a.startedAt);
}

/** Most recently completed first (the server's inbox order). */
export function compareInbox(a: InboxRow, b: InboxRow): number {
  return (b.run.completedAt ?? '').localeCompare(a.run.completedAt ?? '');
}
