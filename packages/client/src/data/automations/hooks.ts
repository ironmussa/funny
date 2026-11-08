import type { Automation, AutomationRun } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import {
  compareAutomations,
  compareInbox,
  compareRuns,
  getAutomationsData,
  getInboxData,
  getRunsData,
  type InboxRow,
} from './store';

/** React reads of automations, run history and the inbox (live queries). */

const NONE: never[] = [];

/** One project's automations, newest created first, then server order. */
export function useProjectAutomations(projectId: string | null | undefined): Automation[] {
  const data = getAutomationsData(useDataLayer());
  const id = projectId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('automations:useProjectAutomations', data.collection, id),
    query: (q) => q.from({ a: data.collection }).where(({ a }) => eq(a.projectId, id)),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return NONE;
    return rows.map((row) => data.fromRow(row as Automation)).sort(compareAutomations(data));
  }, [rows, data]);
}

/** One automation's runs, newest first. */
export function useAutomationRuns(automationId: string | null | undefined): AutomationRun[] {
  const data = getRunsData(useDataLayer());
  const id = automationId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('automations:useAutomationRuns', data.collection, id),
    query: (q) => q.from({ run: data.collection }).where(({ run }) => eq(run.automationId, id)),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return NONE;
    return rows.map((row) => data.fromRow(row as AutomationRun)).sort(compareRuns);
  }, [rows, data]);
}

/** The inbox, most recently completed first, and how many items await triage. */
export function useAutomationInbox(): { inbox: InboxRow[]; pendingCount: number } {
  const data = getInboxData(useDataLayer());
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('automations:useAutomationInbox', data.collection),
    query: (q) => q.from({ item: data.collection }),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return { inbox: NONE, pendingCount: 0 };
    const inbox = rows.map((row) => data.fromRow(row as InboxRow)).sort(compareInbox);
    const pendingCount = inbox.filter((item) => item.run.triageStatus === 'pending').length;
    return { inbox, pendingCount };
  }, [rows, data]);
}
