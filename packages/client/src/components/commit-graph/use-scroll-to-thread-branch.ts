import type { Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';

import { findThreadBranchRowIndex, type GraphEntry } from '@/components/commit-graph/graph-entry';

/**
 * Brings the open thread's branch tip into view once per thread (and again if
 * its branch changes), so selecting a thread shows where it sits in the
 * history. Later scrolling by the user is left alone.
 */
export function useScrollToThreadBranch({
  threadId,
  threadBranch,
  entries,
  visible,
  virtualizer,
}: {
  threadId: string | undefined;
  threadBranch: string | null;
  entries: readonly GraphEntry[];
  visible: boolean;
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'scrollToIndex'>;
}) {
  const scrolledKeyRef = useRef<string | null>(null);
  const index = useMemo(
    () => findThreadBranchRowIndex(entries, threadBranch),
    [entries, threadBranch],
  );
  useEffect(() => {
    if (!visible || !threadId || !threadBranch || index < 0) return;
    const key = `${threadId}::${threadBranch}`;
    if (scrolledKeyRef.current === key) return;
    scrolledKeyRef.current = key;
    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [visible, threadId, threadBranch, index, virtualizer]);
}
