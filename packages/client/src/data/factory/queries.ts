import type {
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryRun,
  FactorySettings,
} from '@funny/shared/contracts/factory';

import { factoryApi } from '@/lib/api/factory';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * The caller's issue factory settings for one project, as a session query. It
 * only changes through this session's own saves (the watcher never edits it,
 * except to turn it off when the caller loses access, which a reconnect's
 * resync picks up), so a save records the server's answer with
 * `writeFactorySettings`.
 */

const factorySettingsKey = (projectId: string) => ['factory', 'settings', projectId] as const;

export function factorySettingsQuery(projectId: string) {
  return {
    queryKey: factorySettingsKey(projectId),
    queryFn: (): Promise<FactorySettings | null> => unwrapResult(factoryApi.getSettings(projectId)),
    staleTime: 30_000,
  };
}

const factoryRunsKey = (projectId: string) => ['factory', 'runs', projectId] as const;

/**
 * The caller's factory runs for a project. The server's watcher advances them
 * with no realtime event, so a reader polls while it is shown.
 */
export function factoryRunsQuery(projectId: string) {
  return {
    queryKey: factoryRunsKey(projectId),
    queryFn: (): Promise<FactoryRun[]> => unwrapResult(factoryApi.listRuns(projectId)),
    staleTime: 10_000,
    refetchInterval: 15_000,
  };
}

const activeFactoryRunsKey = ['factory', 'active-runs'] as const;

/**
 * The caller's runs across projects that have threads and have not ended. The
 * thread lists read it to show a factory thread as busy while its run works
 * outside the agent (CI, merge); only rows of factory threads subscribe, so a
 * session without them never polls.
 */
export function activeFactoryRunsQuery() {
  return {
    queryKey: activeFactoryRunsKey,
    queryFn: (): Promise<FactoryRun[]> => unwrapResult(factoryApi.listActiveRuns()),
    staleTime: 10_000,
    refetchInterval: 15_000,
  };
}

/** What a thread that is not a factory thread reads instead: never fetched. */
export const NO_ACTIVE_FACTORY_RUNS = {
  queryKey: ['factory', 'active-runs', 'none'] as const,
  queryFn: (): Promise<FactoryRun[]> => Promise.resolve([]),
  enabled: false,
};

/** Re-read the runs now (after a send, a clear or a stop all changed several at once). */
export function refreshFactoryRuns(projectId: string, layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  void layer.queryClient.invalidateQueries({ queryKey: factoryRunsKey(projectId) });
  void layer.queryClient.invalidateQueries({ queryKey: activeFactoryRunsKey, exact: true });
}

/**
 * The flows a send may pick: the built-ins, plus the repository's flows when
 * the factory can read them. They change only with the default branch.
 */
export function factoryFlowsQuery(projectId: string) {
  return {
    queryKey: ['factory', 'flows', projectId] as const,
    queryFn: (): Promise<FactoryFlowOption[]> => unwrapResult(factoryApi.listFlows(projectId)),
    staleTime: 5 * 60_000,
  };
}

/** The open blockers of the selected issues (the send bar's warning). */
export function factoryBlockersQuery(projectId: string, issueNumbers: number[]) {
  const sorted = [...issueNumbers].sort((a, b) => a - b);
  return {
    queryKey: ['factory', 'blockers', projectId, sorted] as const,
    queryFn: (): Promise<FactoryIssueBlockers[]> =>
      unwrapResult(factoryApi.blockers(projectId, sorted)),
    staleTime: 30_000,
    enabled: sorted.length > 0,
  };
}

/** Put a run the server just changed into the cached list. */
export function writeFactoryRun(
  projectId: string,
  run: FactoryRun,
  layer: DataLayer = getDataLayer(),
): void {
  if (layer.disposed) return;
  layer.queryClient.setQueryData<FactoryRun[]>(factoryRunsKey(projectId), (runs) =>
    runs?.map((r) => (r.id === run.id ? run : r)),
  );
  // The thread lists' copy: the run may have ended, which drops it from there.
  void layer.queryClient.invalidateQueries({ queryKey: activeFactoryRunsKey, exact: true });
}

/** Record the settings a save returned (the server's confirmed state). */
export function writeFactorySettings(
  settings: FactorySettings,
  layer: DataLayer = getDataLayer(),
): void {
  if (layer.disposed) return;
  layer.queryClient.setQueryData<FactorySettings | null>(
    factorySettingsKey(settings.projectId),
    settings,
  );
}
