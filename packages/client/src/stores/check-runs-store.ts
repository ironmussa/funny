import type { WSCheckRunData } from '@funny/shared';
import { create } from 'zustand';

/** Runs kept per thread; older ones have long since returned their result. */
const RUNS_PER_THREAD = 50;

interface CheckRunsState {
  /** threadId → inputKey → the latest run announced for that input. */
  byThread: Record<string, Record<string, WSCheckRunData>>;
  record: (threadId: string, run: WSCheckRunData) => void;
}

/**
 * Where a `funny_run_checks` call's progress file is while the call is still
 * running: the runner announces each run (`agent:check_run`) keyed by
 * `checkInputKey(input)`, and the tool card looks its own input up here. A
 * finished call carries `progressPath` in its result, so nothing here needs to
 * survive a reload.
 */
export const useCheckRunsStore = create<CheckRunsState>((set) => ({
  byThread: {},
  record: (threadId, run) =>
    set((state) => {
      const runs = { ...state.byThread[threadId], [run.inputKey]: run };
      const keys = Object.keys(runs);
      for (const key of keys.slice(0, Math.max(0, keys.length - RUNS_PER_THREAD))) delete runs[key];
      return { byThread: { ...state.byThread, [threadId]: runs } };
    }),
}));

/** The latest run announced for this thread and input key, if any. */
export function useCheckRun(
  threadId: string | undefined,
  inputKey: string,
): WSCheckRunData | undefined {
  return useCheckRunsStore((state) =>
    threadId ? state.byThread[threadId]?.[inputKey] : undefined,
  );
}
