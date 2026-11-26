import type { AgentProvider } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import {
  accountKey,
  getAgentAccountStore,
  getThreadAccountStore,
  type AgentAccountRow,
} from './store';

/**
 * The agent account a thread runs on: the one its last run reported, else
 * the one of the thread's recorded provider + execution profile
 * (`agentProfileId`), so an idle thread still shows its account's latest usage
 * without bleeding across providers.
 */
export function useThreadAgentAccount(
  threadId: string | undefined,
  profileId: string | null | undefined,
  provider?: AgentProvider | null,
): AgentAccountRow | undefined {
  const layer = useDataLayer();
  const links = getThreadAccountStore(layer);
  const accounts = getAgentAccountStore(layer);
  const id = threadId ?? '';
  const { data: linkRows } = useLiveQuery({
    queryKey: liveQueryKey('agent-account:link', links.collection, id),
    query: (q) => q.from({ l: links.collection }).where(({ l }) => eq(l.id, id)),
  });
  const key = linkRows?.[0]?.accountKey ?? accountKey(profileId, provider);
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('agent-account:row', accounts.collection, key),
    query: (q) => q.from({ a: accounts.collection }).where(({ a }) => eq(a.id, key)),
  });
  const row = rows?.[0];
  return useMemo(() => {
    if (!row) return undefined;
    const account = accounts.fromRow(row);
    if (provider && account.provider && account.provider !== provider) return undefined;
    return account;
  }, [row, accounts, provider]);
}
