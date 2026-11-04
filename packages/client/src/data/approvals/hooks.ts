import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { compareApprovals, getApprovalsData, type PendingApproval } from './store';

const NONE: PendingApproval[] = [];

/** Pending approvals, oldest request first. */
export function usePendingApprovals(): PendingApproval[] {
  const data = getApprovalsData(useDataLayer());
  const { data: rows } = useLiveQuery((q) => q.from({ approval: data.collection }));
  return useMemo(() => {
    if (!rows || rows.length === 0) return NONE;
    return rows.map((row) => data.fromRow(row as PendingApproval)).sort(compareApprovals);
  }, [rows, data]);
}
