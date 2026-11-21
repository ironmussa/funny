import type { AgentAccountInfo, AgentPlanUsage, WSAgentAccountData } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { ownEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * The agent account (Claude login + plan usage) per funny execution profile.
 * The runtime pushes it over WS (`agent:account`) at session start and after
 * every turn; there is no endpoint. Rows are keyed by account, not by thread,
 * so every thread on the same profile shows the account's latest usage. A
 * second store links each thread to the account its last run used.
 * Persisting across reloads is the caller's job (`restoreAgentAccounts`).
 */

export interface AgentAccountRow {
  /** {@link accountKey} of the profile. */
  id: string;
  profileId: string | null;
  profileName: string | null;
  account: AgentAccountInfo;
  usage?: AgentPlanUsage;
  /** Epoch ms of the event that carried `usage` (or the account). */
  capturedAt: number;
}

interface ThreadAccountLink {
  id: string;
  accountKey: string;
}

const DEFAULT_ACCOUNT_KEY = 'default';

/** Rows key: the execution profile, or the runner's default login. */
export function accountKey(profileId: string | null | undefined): string {
  return profileId ? `profile:${profileId}` : DEFAULT_ACCOUNT_KEY;
}

export function getAgentAccountStore(
  layer: DataLayer = getDataLayer(),
): EntityStore<AgentAccountRow> {
  return ownEntityStore<AgentAccountRow>(layer, 'agent-accounts');
}

export function getThreadAccountStore(
  layer: DataLayer = getDataLayer(),
): EntityStore<ThreadAccountLink> {
  return ownEntityStore<ThreadAccountLink>(layer, 'agent-account-threads');
}

/**
 * Apply an `agent:account` event. An event without usage (the usage request
 * timed out) keeps the last usage of the same login rather than blanking it.
 * Returns every account row, for the caller to persist.
 */
export function applyAgentAccountEvent(
  threadId: string,
  data: WSAgentAccountData,
  now: number = Date.now(),
  layer: DataLayer = getDataLayer(),
): AgentAccountRow[] {
  const store = getAgentAccountStore(layer);
  const key = accountKey(data.profileId);
  const previous = store.getSynced(key);
  const sameLogin = previous?.account.email === data.account.email;
  const usage = data.usage ?? (sameLogin ? previous?.usage : undefined);
  store.upsert([
    {
      id: key,
      profileId: data.profileId,
      profileName: data.profileName,
      account: data.account,
      usage,
      capturedAt: data.usage || !sameLogin ? now : (previous?.capturedAt ?? now),
    },
  ]);
  getThreadAccountStore(layer).upsert([{ id: threadId, accountKey: key }]);
  return [...store.collection.values()].map((row) => store.fromRow(row));
}

/** Restore account rows from a persisted snapshot when the session has none yet. */
export function restoreAgentAccounts(
  load: () => AgentAccountRow[],
  layer: DataLayer = getDataLayer(),
): void {
  const store = getAgentAccountStore(layer);
  if (store.collection.size > 0) return;
  const rows = load();
  if (rows.length > 0) store.upsert(rows);
}
