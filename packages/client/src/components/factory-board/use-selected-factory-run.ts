/**
 * The run whose detail panel is open, named by the view's `run` search
 * parameter so the panel can be linked (openspec factory-run-detail, D1). The
 * run is looked up among the listed runs on every render, so the panel follows
 * it; an id that is not listed (once the runs have loaded) clears the parameter.
 */
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { FactoryQueueRun } from '@/lib/api/factory';

const PARAM = 'run';

export function useSelectedFactoryRun(runs: readonly FactoryQueueRun[] | undefined) {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(PARAM);
  const run = selectedId ? runs?.find((candidate) => candidate.id === selectedId) : undefined;

  const setSelected = useCallback(
    (id: string | null) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id) next.set(PARAM, id);
          else next.delete(PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const missing = selectedId !== null && runs !== undefined && run === undefined;
  useEffect(() => {
    if (missing) setSelected(null);
  }, [missing, setSelected]);

  const select = useCallback(
    (selected: FactoryQueueRun) => setSelected(selected.id),
    [setSelected],
  );
  const close = useCallback(() => setSelected(null), [setSelected]);
  return { run, select, close };
}
