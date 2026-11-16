import type { FactorySettings } from '@funny/shared/contracts/factory';

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
