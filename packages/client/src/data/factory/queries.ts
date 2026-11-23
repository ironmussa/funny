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

import { factoryApi } from '@/lib/api/factory';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { unwrapResult, type QueryStatusView } from '../query-client';
import { getDataLayer } from '../runtime';

const log = createClientLogger('factory');

/**
 * The caller's issue factory settings for one project, as a session query. It
 * only changes through this session's own saves (the watcher never edits it,
 * except to turn it off when the caller loses access, which a reconnect's
 * resync picks up), so a save records the server's answer with
 * `writeFactorySettings`.
 */

const factorySettingsKey = (projectId: string) => ['factory', 'settings', projectId] as const;

/** How often a failed settings read is tried again while something shows it. */
export const FACTORY_SETTINGS_RETRY_MS = 15_000;

/**
 * Retries are off in the data layer, and a failed read leaves no settings,
 * which reads as "no factory": the Issues tab would hide its checkboxes until
 * something else refetched. So a reader polls only while the read has failed.
 */
export function factorySettingsQuery(projectId: string) {
  return {
    queryKey: factorySettingsKey(projectId),
    queryFn: (): Promise<FactorySettings | null> =>
      unwrapResult(factoryApi.getSettings(projectId)).catch((error: unknown) => {
        log.warn('failed to load factory settings', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }),
    staleTime: 30_000,
    refetchInterval: (query: QueryStatusView) =>
      query.state.status === 'error' ? FACTORY_SETTINGS_RETRY_MS : false,
  };
}

/** Read the settings again now (the Issues tab's retry after a failed read). */
export function refetchFactorySettings(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  if (layer.disposed) return Promise.resolve();
  return layer.queryClient.refetchQueries({ queryKey: factorySettingsKey(projectId), exact: true });
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

const queueRunsKey = ['factory', 'queue-runs'] as const;

/**
 * The factory view: the caller's unended runs across projects, queued ones
 * included, each with its project. Polled while the view is shown, like the
 * per-project run list.
 */
export function factoryQueueRunsQuery() {
  return {
    queryKey: queueRunsKey,
    queryFn: (): Promise<FactoryQueueRun[]> => unwrapResult(factoryApi.listQueueRuns()),
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
  void layer.queryClient.invalidateQueries({ queryKey: queueRunsKey, exact: true });
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

/**
 * One flow's YAML (the settings page's viewer). Read only while a flow is
 * chosen; like the flow list, it changes only with the default branch.
 */
export function factoryFlowDefinitionQuery(projectId: string, flowName: string | null) {
  return {
    queryKey: ['factory', 'flow-definition', projectId, flowName] as const,
    queryFn: (): Promise<FactoryFlowDefinition> =>
      unwrapResult(factoryApi.getFlowDefinition(projectId, flowName ?? '')),
    staleTime: 5 * 60_000,
    enabled: !!flowName,
  };
}

/**
 * How the repository merges through the merge queue (openspec
 * factory-integration D12): its rules and workflows change rarely.
 */
export function factoryReadinessQuery(projectId: string) {
  return {
    queryKey: ['factory', 'readiness', projectId] as const,
    queryFn: (): Promise<FactoryReadiness> => unwrapResult(factoryApi.readiness(projectId)),
    staleTime: 5 * 60_000,
  };
}

/**
 * Validate flow: the flow as an admitted run would load it now. Runs only when
 * asked (`requested`), and again each time it is asked, since the default
 * branch or the overrides may have changed.
 */
export function factoryFlowValidationQuery(
  projectId: string,
  flowName: string,
  requested: boolean,
  /** The factory's step overrides: the answer resolves with them, so it is asked again on a change. */
  overrides: FactoryStepOverrides = {},
) {
  return {
    queryKey: ['factory', 'flow-validation', projectId, flowName, overrides] as const,
    queryFn: (): Promise<FactoryFlowValidation> =>
      unwrapResult(factoryApi.validateFlow(projectId, flowName)),
    staleTime: 0,
    enabled: requested,
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

const factoryTriggersKey = (projectId: string) => ['factory', 'triggers', projectId] as const;

/**
 * The schedule triggers of the caller's factory (change flow-triggers). They
 * change only through this session's own saves, which re-read them.
 */
export function factoryTriggersQuery(projectId: string) {
  return {
    queryKey: factoryTriggersKey(projectId),
    queryFn: (): Promise<FactoryTrigger[]> => unwrapResult(factoryApi.listTriggers(projectId)),
    staleTime: 30_000,
  };
}

/** Read the triggers again after a save or a removal. */
export function refreshFactoryTriggers(projectId: string, layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  void layer.queryClient.invalidateQueries({ queryKey: factoryTriggersKey(projectId) });
}

/**
 * Whether `flowName` can run without an issue, and the inputs to type to start
 * it. Asked again each time: the flow on the default branch may have changed.
 */
export function factoryIssuelessFlowQuery(projectId: string, flowName: string) {
  return {
    queryKey: ['factory', 'issueless-flow', projectId, flowName] as const,
    queryFn: (): Promise<FactoryIssuelessFlow> =>
      unwrapResult(factoryApi.getIssuelessFlow(projectId, flowName)),
    staleTime: 0,
    enabled: !!flowName,
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
  // The thread lists' and the factory view's copies: the run may have ended,
  // which drops it from there.
  void layer.queryClient.invalidateQueries({ queryKey: activeFactoryRunsKey, exact: true });
  void layer.queryClient.invalidateQueries({ queryKey: queueRunsKey, exact: true });
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
