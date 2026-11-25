import type { AgentAccountRow } from '@/data/agent-account/store';

import { createClientLogger } from './client-logger';

const log = createClientLogger('agent-account-storage');
const KEY = 'funny:agentAccounts';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Last known agent accounts, so the usage shows before the next run reports it. */
export function loadAgentAccounts(): AgentAccountRow[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (row): row is AgentAccountRow =>
        !!row &&
        typeof row.id === 'string' &&
        typeof row.capturedAt === 'number' &&
        now - row.capturedAt < MAX_AGE_MS,
    );
  } catch (err) {
    log.warn('load failed', { error: String(err) });
    return [];
  }
}

export function saveAgentAccounts(rows: AgentAccountRow[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch (err) {
    log.warn('save failed', { error: String(err) });
  }
}
