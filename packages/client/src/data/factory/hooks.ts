import type {
  FactoryFlowDefinition,
  FactoryFlowValidation,
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryQueueRun,
  FactoryReadiness,
  FactoryRun,
  FactorySettings,
  FactoryStepOverrides,
} from '@funny/shared/contracts/factory';

import { hasLaterRunOfIssue } from '@/lib/thread-activity';

import { useDataQuery } from '../hooks';
import {
  activeFactoryRunsQuery,
  NO_ACTIVE_FACTORY_RUNS,
  NO_PROJECT_FACTORY_RUNS,
  factoryBlockersQuery,
  factoryFlowDefinitionQuery,
  factoryFlowValidationQuery,
  factoryFlowsQuery,
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
 * The run a factory thread belongs to, from its project's run list (polled
 * while shown), or null; `undefined` while loading. Any other thread answers
 * null without a request.
 */
export function useFactoryRunOfThread(
  thread: { id: string; projectId?: string; source?: string } | null | undefined,
): FactoryRun | null | undefined {
  const projectId = thread?.source === 'factory' ? thread.projectId : undefined;
  const runs = useDataQuery(projectId ? factoryRunsQuery(projectId) : NO_PROJECT_FACTORY_RUNS).data;
  if (!projectId || !thread) return null;
  return runs && (runs.find((run) => run.threadIds.includes(thread.id)) ?? null);
}

/**
 * The factory run a thread belongs to, from any project, or null: unended, or
 * ended without merging lately (failed, stopped, no change). `resent` says the
 * same issue went into the factory again as a later run. Only a factory thread
 * reads the caller's active runs (polled while shown); any other thread
 * answers null without a request.
 */
export function useActiveFactoryRunForThread(thread: {
  id: string;
  source?: string;
}): { run: FactoryRun; resent: boolean } | null {
  const isFactoryThread = thread.source === 'factory';
  const runs = useDataQuery(
    isFactoryThread ? activeFactoryRunsQuery() : NO_ACTIVE_FACTORY_RUNS,
  ).data;
  const run = runs?.find((r) => r.threadIds.includes(thread.id));
  if (!runs || !run) return null;
  return { run, resent: hasLaterRunOfIssue(runs, run) };
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
