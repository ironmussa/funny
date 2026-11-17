import type {
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryRun,
  FactorySettings,
} from '@funny/shared/contracts/factory';

import { useDataQuery } from '../hooks';
import {
  factoryBlockersQuery,
  factoryFlowsQuery,
  factoryRunsQuery,
  factorySettingsQuery,
} from './queries';

/** The caller's factory settings for a project; `null` when never configured, `undefined` while loading. */
export function useFactorySettings(projectId: string): FactorySettings | null | undefined {
  return useDataQuery(factorySettingsQuery(projectId)).data;
}

/** The caller's factory runs for a project, newest first; `undefined` while loading. */
export function useFactoryRuns(projectId: string): FactoryRun[] | undefined {
  return useDataQuery(factoryRunsQuery(projectId)).data;
}

/** The flows a send may pick; `undefined` while loading. */
export function useFactoryFlows(projectId: string): FactoryFlowOption[] | undefined {
  return useDataQuery(factoryFlowsQuery(projectId)).data;
}

/** The open blockers of `issueNumbers`; empty while none are selected. */
export function useFactoryBlockers(
  projectId: string,
  issueNumbers: number[],
): FactoryIssueBlockers[] | undefined {
  return useDataQuery(factoryBlockersQuery(projectId, issueNumbers)).data;
}
