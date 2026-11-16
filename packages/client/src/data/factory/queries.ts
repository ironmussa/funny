import type { FactoryRun, FactorySettings } from '@funny/shared/contracts/factory';

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
