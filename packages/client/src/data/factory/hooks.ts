import type {
  FactoryApprovalRequest,
  FactoryFlowDefinition,
  FactoryFlowValidation,
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryIssuelessFlow,
  FactoryLane,
  FactoryQueueRun,
  FactoryReadiness,
  FactoryRun,
  FactorySettings,
  FactoryStepOverrides,
  FactoryTrigger,
} from '@funny/shared/contracts/factory';

import { hasLaterRunOfIssue, latestLaterRunOfIssue } from '@/lib/thread-activity';

import { useDataQuery } from '../hooks';
import {
  activeFactoryRunsQuery,
  factoryApprovalRequestsQuery,
  NO_FACTORY_APPROVAL_REQUESTS,
  NO_FACTORY_SETTINGS,
  NO_ACTIVE_FACTORY_RUNS,
  NO_PROJECT_FACTORY_RUNS,
  factoryBlockersQuery,
  factoryFlowDefinitionQuery,
  factoryFlowValidationQuery,
  factoryFlowsQuery,
  factoryIssuelessFlowQuery,
  factoryLanesQuery,
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
 * The newest run of `run`'s issue started after it in the same project, or
 * null (also while the project's run list loads): the issue was sent again.
 */
export function useLaterRunOfIssue(projectId: string, run: FactoryRun | null | undefined) {
  const runs = useFactoryRuns(projectId);
  return runs && run ? latestLaterRunOfIssue(runs, run) : null;
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

/** What `useFactoryFlowDefinition` returns. */
interface FactoryFlowDefinitionRead {
  definition: FactoryFlowDefinition | undefined;
  error: Error | null;
}

/** One flow's YAML while `flowName` is set; `undefined` while loading or none is chosen. */
export function useFactoryFlowDefinition(
  projectId: string,
  flowName: string | null,
): FactoryFlowDefinitionRead {
  const { data, error } = useDataQuery(factoryFlowDefinitionQuery(projectId, flowName));
  return { definition: data, error: error ?? null };
}

/** What `useFactoryFlowValidation` returns. */
interface FactoryFlowValidationRead {
  validation: FactoryFlowValidation | undefined;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
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
): FactoryFlowValidationRead {
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

/** The lanes of the caller's factory; `undefined` while loading. */
export function useFactoryLanes(projectId: string): FactoryLane[] | undefined {
  return useDataQuery(factoryLanesQuery(projectId)).data;
}

/** What `useFactoryIssuelessFlow` returns. */
interface FactoryIssuelessFlowRead {
  flow: FactoryIssuelessFlow | undefined;
  error: Error | null;
  loading: boolean;
}

/** Whether `flowName` can run without an issue and its inputs; `undefined` while loading. */
export function useFactoryIssuelessFlow(
  projectId: string,
  flowName: string,
): FactoryIssuelessFlowRead {
  const { data, error, isFetching } = useDataQuery(factoryIssuelessFlowQuery(projectId, flowName));
  return { flow: data, error: error ?? null, loading: isFetching };
}

/**
 * What agents asked the caller to approve in a project, newest first;
 * `undefined` while loading. With `enabled` false nothing is requested: a
 * reader with no factory, or no run waiting for an approval, never polls.
 */
export function useFactoryApprovalRequests(
  projectId: string | undefined,
  enabled = true,
): FactoryApprovalRequest[] | undefined {
  const ask = enabled && !!projectId;
  return useDataQuery(
    ask && projectId ? factoryApprovalRequestsQuery(projectId) : NO_FACTORY_APPROVAL_REQUESTS,
  ).data;
}

/**
 * Whether the caller has a factory in the project, without asking for a
 * project that is not there (a scratch thread).
 */
export function useHasFactory(projectId: string | undefined): boolean {
  return !!useDataQuery(projectId ? factorySettingsQuery(projectId) : NO_FACTORY_SETTINGS).data;
}

/** The pending request an agent made for `runId`, or null. */
export function usePendingApprovalRequestOfRun(
  projectId: string | undefined,
  runId: string,
  enabled = true,
): FactoryApprovalRequest | null {
  const requests = useFactoryApprovalRequests(projectId, enabled);
  return (
    requests?.find((request) => request.runId === runId && request.state === 'pending') ?? null
  );
}
