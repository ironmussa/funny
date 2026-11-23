import type {
  FactoryFlowDefinition,
  FactoryFlowValidation,
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryIssuelessFlow,
  FactoryQueueRun,
  FactoryReadiness,
  FactoryRun,
  FactorySettings,
  FactoryStepOverrides,
  FactoryTrigger,
} from '@funny/shared/contracts/factory';

import { useDataQuery } from '../hooks';
import {
  activeFactoryRunsQuery,
  NO_ACTIVE_FACTORY_RUNS,
  factoryBlockersQuery,
  factoryFlowDefinitionQuery,
  factoryFlowValidationQuery,
  factoryFlowsQuery,
  factoryIssuelessFlowQuery,
  factoryTriggersQuery,
  factoryQueueRunsQuery,
  factoryReadinessQuery,
  factoryRunsQuery,
  factorySettingsQuery,
} from './queries';

/** The caller's factory settings for a project; `null` when never configured, `undefined` while loading. */
export function useFactorySettings(projectId: string): FactorySettings | null | undefined {
  return useDataQuery(factorySettingsQuery(projectId)).data;
}

/**
 * Whether reading the caller's factory settings failed and there is nothing to
 * show: unlike `null` (never configured), the factory may well exist. The read
 * is retried while shown (`factorySettingsQuery`).
 */
export function useFactorySettingsFailed(projectId: string): boolean {
  const { isError, data } = useDataQuery(factorySettingsQuery(projectId));
  return isError && data === undefined;
}

/** The caller's factory runs for a project, newest first; `undefined` while loading. */
export function useFactoryRuns(projectId: string): FactoryRun[] | undefined {
  return useDataQuery(factoryRunsQuery(projectId)).data;
}

/**
 * The caller's factory run that started `threadId`, or null; `undefined` while
 * loading. Reads the project's run list (polled while shown), so the thread
 * view follows the run as the watcher advances it.
 */
export function useFactoryRunForThread(
  projectId: string,
  threadId: string,
): FactoryRun | null | undefined {
  const runs = useFactoryRuns(projectId);
  return runs && (runs.find((run) => run.threadIds.includes(threadId)) ?? null);
}

/**
 * The unended factory run a thread belongs to, from any project, or null. Only
 * a factory thread reads the caller's active runs (polled while shown); any
 * other thread answers null without a request.
 */
export function useActiveFactoryRunForThread(thread: {
  id: string;
  source?: string;
}): FactoryRun | null {
  const isFactoryThread = thread.source === 'factory';
  const runs = useDataQuery(
    isFactoryThread ? activeFactoryRunsQuery() : NO_ACTIVE_FACTORY_RUNS,
  ).data;
  return runs?.find((run) => run.threadIds.includes(thread.id)) ?? null;
}

/** The factory view's runs across projects, newest first; `undefined` while loading. */
export function useFactoryQueueRuns(): FactoryQueueRun[] | undefined {
  return useDataQuery(factoryQueueRunsQuery()).data;
}

/** The flows a send may pick; `undefined` while loading. */
export function useFactoryFlows(projectId: string): FactoryFlowOption[] | undefined {
  return useDataQuery(factoryFlowsQuery(projectId)).data;
}

/** One flow's YAML while `flowName` is set; `undefined` while loading or none is chosen. */
export function useFactoryFlowDefinition(
  projectId: string,
  flowName: string | null,
): { definition: FactoryFlowDefinition | undefined; error: Error | null } {
  const { data, error } = useDataQuery(factoryFlowDefinitionQuery(projectId, flowName));
  return { definition: data, error: error ?? null };
}

/**
 * Validate flow's answer for `flowName`, once `requested`; `refresh` asks again
 * (after a change to the flow or the overrides).
 */
export function useFactoryFlowValidation(
  projectId: string,
  flowName: string,
  requested: boolean,
  overrides: FactoryStepOverrides,
): {
  validation: FactoryFlowValidation | undefined;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
} {
  const { data, error, isFetching, refetch } = useDataQuery(
    factoryFlowValidationQuery(projectId, flowName, requested, overrides),
  );
  return {
    validation: data,
    error: error ?? null,
    loading: isFetching,
    refresh: () => void refetch(),
  };
}

/** How the repository merges through the merge queue, and why; `undefined` while loading. */
export function useFactoryReadiness(projectId: string): FactoryReadiness | undefined {
  return useDataQuery(factoryReadinessQuery(projectId)).data;
}

/** The open blockers of `issueNumbers`; empty while none are selected. */
export function useFactoryBlockers(
  projectId: string,
  issueNumbers: number[],
): FactoryIssueBlockers[] | undefined {
  return useDataQuery(factoryBlockersQuery(projectId, issueNumbers)).data;
}

/** The schedule triggers of the caller's factory; `undefined` while loading. */
export function useFactoryTriggers(projectId: string): FactoryTrigger[] | undefined {
  return useDataQuery(factoryTriggersQuery(projectId)).data;
}

/** Whether `flowName` can run without an issue and its inputs; `undefined` while loading. */
export function useFactoryIssuelessFlow(
  projectId: string,
  flowName: string,
): { flow: FactoryIssuelessFlow | undefined; error: Error | null; loading: boolean } {
  const { data, error, isFetching } = useDataQuery(factoryIssuelessFlowQuery(projectId, flowName));
  return { flow: data, error: error ?? null, loading: isFetching };
}
