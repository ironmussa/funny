import type { Automation, AutomationRun, InboxItem } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getAutomationsData, getInboxData, getRunsData, toInboxRow } from './store';

/** Make the given rows the session's automations, runs and inbox (tests and stories). */
export function seedAutomations(
  {
    automations = [],
    runs = [],
    inbox = [],
  }: { automations?: Automation[]; runs?: AutomationRun[]; inbox?: InboxItem[] },
  layer: DataLayer = getDataLayer(),
): void {
  const data = getAutomationsData(layer);
  automations.forEach((a, i) => data.position.set(a.id, i));
  data.replaceAll(automations);
  const runsData = getRunsData(layer);
  runsData.replaceAll(runs);
  for (const run of runs) runsData.loadedFor.add(run.automationId);
  getInboxData(layer).replaceAll(inbox.map(toInboxRow));
}
