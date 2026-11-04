import type { Automation, AutomationRun } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, ResultAsync } from 'neverthrow';

import { automationsApi } from '@/lib/api/automations';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { toDomainError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { getAutomationsData, getInboxData, getRunsData, toInboxRow, type InboxRow } from './store';

const log = createClientLogger('automations');

/** Inbox loads closer together than this share one request (WS bursts, poll + mount). */
const INBOX_COALESCE_MS = 2_000;

function fetchInto<T>(
  layer: DataLayer,
  what: string,
  query: { queryKey: readonly unknown[]; staleTime?: number; queryFn: () => Promise<T> },
): ResultAsync<T, DomainError> {
  return ResultAsync.fromPromise(
    layer.queryClient.fetchQuery({ staleTime: 0, ...query }),
    toDomainError,
  ).mapErr((error) => {
    log.warn(`failed to load ${what}`, { error: error.message });
    return error;
  });
}

/** Load one project's automations (server order). */
export function loadAutomations(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<Automation[], DomainError> {
  const data = getAutomationsData(layer);
  return fetchInto(layer, 'automations', {
    queryKey: ['automations', projectId],
    queryFn: async () => {
      const rows = await unwrapResult(automationsApi.listAutomations(projectId));
      rows.forEach((a, i) => data.position.set(a.id, i));
      data.replaceWhere((a) => a.projectId === projectId, rows);
      return rows;
    },
  });
}

/** Load one automation's run history; realtime run events keep it current afterwards. */
export function loadAutomationRuns(
  automationId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<AutomationRun[], DomainError> {
  const data = getRunsData(layer);
  return fetchInto(layer, 'automation runs', {
    queryKey: ['automation-runs', automationId],
    queryFn: async () => {
      const rows = await unwrapResult(automationsApi.listAutomationRuns(automationId));
      data.replaceWhere((r) => r.automationId === automationId, rows);
      data.loadedFor.add(automationId);
      return rows;
    },
  });
}

/**
 * Load the whole inbox (views filter client-side so tab counts stay right).
 * Skipped without a session user: realtime events and the sidebar poll can
 * fire while logging in or out.
 */
export function loadInbox(
  layer: DataLayer = getDataLayer(),
): ResultAsync<InboxRow[] | null, DomainError> {
  if (!layer.userId) return okAsync(null);
  const data = getInboxData(layer);
  return fetchInto(layer, 'inbox', {
    queryKey: ['automation-inbox'],
    staleTime: INBOX_COALESCE_MS,
    queryFn: async () => {
      const rows = (await unwrapResult(automationsApi.getAutomationInbox())).map(toInboxRow);
      data.replaceAll(rows);
      return rows;
    },
  });
}
