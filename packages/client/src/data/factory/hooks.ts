import type { FactorySettings } from '@funny/shared/contracts/factory';

import { useDataQuery } from '../hooks';
import { factorySettingsQuery } from './queries';

/** The caller's factory settings for a project; `null` when never configured, `undefined` while loading. */
export function useFactorySettings(projectId: string): FactorySettings | null | undefined {
  return useDataQuery(factorySettingsQuery(projectId)).data;
}
