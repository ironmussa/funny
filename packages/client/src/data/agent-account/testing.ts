import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getAgentAccountStore, getThreadAccountStore, type AgentAccountRow } from './store';

/** Make `rows` the session's agent accounts, linking `threadId` to the first (tests and stories). */
export function seedAgentAccounts(
  rows: AgentAccountRow[],
  threadId?: string,
  layer: DataLayer = getDataLayer(),
): void {
  getAgentAccountStore(layer).replaceAll(rows);
  if (threadId && rows[0]) {
    getThreadAccountStore(layer).replaceAll([{ id: threadId, accountKey: rows[0].id }]);
  }
}
