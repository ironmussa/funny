/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The queue of a member's factory (change factory-manual-queue): sending chosen
 * issues to it, the flows a send may pick, the blockers the send bar warns
 * about, and clearing the queue or stopping everything.
 *
 * A send is checked against the live state, never against the stored
 * `blockedReason` (up to a poll old): the factory must be running, its target
 * (the enabler's runtime and the project's repository) must resolve now, the
 * flow must load from the default branch or the built-ins, and each issue must
 * be an open issue of the project's repository. Nothing is written unless all
 * of that holds; then the accepted issues are queued in one go, oldest issue
 * first, behind the factory's queue.
 *
 * The caller (the tRPC port) has checked `steer` and resolved the caller's own
 * factory; everything here acts on that factory only.
 */

import type { GithubCallError } from '@funny/core/github-app';
import type {
  FactoryFlowDefinition,
  FactoryFlowValidation,
  FactoryFlowOption,
  FactoryIssueBlockers,
  FactoryQueueClearResult,
  FactorySubmitResult,
} from '@funny/shared/contracts/factory';
import { err, ok, okAsync, ResultAsync, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { summarizeFactoryFlow } from './factory-flow-validation.js';
import {
  BUILT_IN_FACTORY_FLOWS,
  listFactoryFlows,
  flowReadsOf,
  loadFactoryFlow,
  readFactoryFlowDefinition,
} from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssueDetail, FactoryRepoReader } from './factory-github.js';
import { createFactoryRunControl } from './factory-run-control.js';
import { createFactoryRunsRepository } from './factory-runs.js';
import {
  getWatchedFactory,
  projectAgentDefaults,
  type WatchedFactory,
} from './factory-settings.js';
import {
  checkFactoryTarget,
  factoryGithubPort,
  pokeFactory,
  type FactoryTarget,
} from './factory-watcher.js';

export type FactoryQueueError =
  | { kind: 'not-found'; message: string }
  /** The factory is paused: nothing may be sent. */
  | { kind: 'paused'; message: string }
  /** The factory cannot work now (runner, sandbox, GitHub App…): the message says why. */
  | { kind: 'cannot-work'; message: string }
  /** The chosen flow is unknown or does not compile. */
  | { kind: 'invalid-flow'; message: string }
  | { kind: 'storage'; message: string };

export interface FactoryQueueDeps {
  runs?: ReturnType<typeof createFactoryRunsRepository>;
  control?: ReturnType<typeof createFactoryRunControl>;
  /** The watcher's GitHub side; null when the watcher is not running here. */
  github?: () => FactoryGithubPort | null;
  /** The live target check; null when the watcher is not running here. */
  target?: (factory: WatchedFactory) => Promise<FactoryTarget | null>;
  factory?: (factoryId: string) => Promise<WatchedFactory | null>;
  /** Look at the factory now instead of at its next poll. */
  wake?: (factoryId: string) => Promise<void>;
}

const NOT_RUNNING_HERE = 'The issue factory is not running on this server.';

/** A token refusal (App missing, not installed, no access): the whole send fails, not one issue. */
const isTokenRefusal = (error: GithubCallError) => error.status === undefined && !!error.kind;

type Refusal = FactorySubmitResult['refused'][number];

/** A flow a send cannot use: unknown or invalid (400), or the repository unreadable now. */
function flowRefusal(error: {
  kind: 'invalid' | 'unavailable';
  message: string;
}): FactoryQueueError {
  return error.kind === 'invalid'
    ? { kind: 'invalid-flow', message: error.message }
    : { kind: 'cannot-work', message: `The repository could not be read: ${error.message}` };
}

/**
 * Whether one issue of a send can be queued: an open issue, or why not. A
 * token refusal fails the whole send (every issue would fail the same way).
 */
function sendable(
  number: number,
  read: Result<FactoryIssueDetail, GithubCallError>,
): Result<{ issue: FactoryIssueDetail } | { refusal: Refusal }, FactoryQueueError> {
  const refuse = (reason: Refusal['reason'], message: string) =>
    ok({ refusal: { issue: number, reason, message } });
  if (read.isErr()) {
    if (isTokenRefusal(read.error))
      return err({ kind: 'cannot-work', message: read.error.message });
    return read.error.status === 404
      ? refuse('not-found', `#${number} does not exist.`)
      : refuse('unreadable', `#${number} could not be read: ${read.error.message}`);
  }
  if (read.value.pullRequest) return refuse('pull-request', `#${number} is a pull request.`);
  if (read.value.state === 'closed') return refuse('closed', `#${number} is closed.`);
  return ok({ issue: read.value });
}

/** Issues sent together go oldest first. */
function oldestFirst(issues: FactoryIssueDetail[]): number[] {
  return issues
    .map((issue) => ({ number: issue.number, createdAt: issue.createdAt ?? '' }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
    .map((issue) => issue.number);
}

const alreadyIn = (issue: number): Refusal => ({
  issue,
  reason: 'already-in-factory',
  message: `#${issue} is already in the factory.`,
});

/**
 * How many runs Stop all stopped. A run that ended meanwhile (a conflict)
 * needs no stop; any other failure means a run may still be going, so Stop all
 * fails instead of claiming success.
 */
function stoppedCount(
  results: Result<unknown, { kind: string; message: string }>[],
): Result<number, { message: string }> {
  const failed = results.find((r) => r.isErr() && r.error.kind !== 'conflict');
  if (failed?.isErr()) return err({ message: failed.error.message });
  return ok(results.filter((r) => r.isOk()).length);
}

export function createFactoryQueue(deps: FactoryQueueDeps = {}) {
  const runs = deps.runs ?? createFactoryRunsRepository();
  const control = deps.control ?? createFactoryRunControl(runs);
  const github = deps.github ?? factoryGithubPort;
  const target = deps.target ?? checkFactoryTarget;
  const loadFactory = deps.factory ?? getWatchedFactory;
  const wake = deps.wake ?? pokeFactory;

  /** The factory and where it runs now, or why a send cannot go in. */
  async function workingFactory(
    factoryId: string,
  ): Promise<
    Result<
      { factory: WatchedFactory; port: FactoryGithubPort; reader: FactoryRepoReader },
      FactoryQueueError
    >
  > {
    const factory = await loadFactory(factoryId);
    if (!factory) return err({ kind: 'not-found', message: 'Set up the issue factory first.' });
    if (!factory.enabled) {
      return err({
        kind: 'paused',
        message: 'The issue factory is paused. Resume it to send issues.',
      });
    }
    const port = github();
    const where = await target(factory);
    if (!port || !where) return err({ kind: 'cannot-work', message: NOT_RUNNING_HERE });
    if ('reason' in where) return err({ kind: 'cannot-work', message: where.reason });
    return ok({
      factory,
      port,
      reader: { repo: where.repo, ownerId: factory.userId, projectId: factory.projectId },
    });
  }

  async function submit(
    factoryId: string,
    input: { issueNumbers: number[]; flowName: string },
  ): Promise<Result<FactorySubmitResult, FactoryQueueError>> {
    const ready = await workingFactory(factoryId);
    if (ready.isErr()) return err(ready.error);
    const { port, reader } = ready.value;

    const flow = await loadFactoryFlow(input.flowName, flowReadsOf(port, reader));
    if (flow.isErr()) return err(flowRefusal(flow.error));

    const refused: FactorySubmitResult['refused'] = [];
    const open: FactoryIssueDetail[] = [];
    for (const number of [...new Set(input.issueNumbers)]) {
      const checked = sendable(number, await port.getIssue(reader, number));
      if (checked.isErr()) return err(checked.error);
      if ('refusal' in checked.value) refused.push(checked.value.refusal);
      else open.push(checked.value.issue);
    }

    const ordered = oldestFirst(open);
    if (ordered.length === 0) return ok({ accepted: [], refused });

    const queued = await runs.enqueue({
      factoryId,
      issueNumbers: ordered,
      flowName: input.flowName,
    });
    if (queued.isErr()) return err({ kind: 'storage', message: queued.error.message });
    const accepted = queued.value.queued.map((run) => run.issueNumber);
    if (accepted.length > 0) wakeFactory(factoryId);
    return ok({ accepted, refused: [...refused, ...queued.value.duplicates.map(alreadyIn)] });
  }

  /** Look at the factory now instead of at its next poll; best-effort. */
  function wakeFactory(factoryId: string): void {
    void wake(factoryId).catch((error: unknown) =>
      log.error('Issue factory poke failed', {
        namespace: 'factory',
        factoryId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** The factory's repository reader when it resolves now, else null (paused does not matter here). */
  async function readerOf(
    factoryId: string,
  ): Promise<{ port: FactoryGithubPort; reader: FactoryRepoReader } | null> {
    const factory = await loadFactory(factoryId);
    const port = github();
    if (!factory || !port) return null;
    const where = await target(factory);
    if (!where || 'reason' in where) return null;
    return {
      port,
      reader: { repo: where.repo, ownerId: factory.userId, projectId: factory.projectId },
    };
  }

  async function flows(factoryId: string): Promise<FactoryFlowOption[]> {
    const builtIns = BUILT_IN_FACTORY_FLOWS.map((name): FactoryFlowOption => ({
      name,
      source: 'built-in',
    }));
    const where = await readerOf(factoryId);
    if (!where) return builtIns;
    const listed = await listFactoryFlows({
      listDefaultBranchDir: (path) => where.port.listDefaultBranchDir(where.reader, path),
    });
    return listed.isOk() ? listed.value : builtIns;
  }

  /**
   * One flow's YAML. Without a factory, or when its repository cannot be read
   * now, only the built-ins are found, as in `flows` (which lists the
   * built-ins in that case).
   */
  async function flowDefinition(
    factoryId: string | null,
    flowName: string,
  ): Promise<Result<FactoryFlowDefinition, FactoryQueueError>> {
    const builtInOnly = {
      readDefaultBranchFile: () => okAsync<string | null, GithubCallError>(null),
    };
    const where = factoryId ? await readerOf(factoryId) : null;
    if (!where) return (await readFactoryFlowDefinition(flowName, builtInOnly)).mapErr(flowRefusal);
    const read = await readFactoryFlowDefinition(flowName, {
      readDefaultBranchFile: (path) => where.port.readDefaultBranchFile(where.reader, path),
    });
    if (read.isErr() && read.error.kind === 'unavailable') {
      return (await readFactoryFlowDefinition(flowName, builtInOnly)).mapErr(flowRefusal);
    }
    return read.mapErr(flowRefusal);
  }

  /**
   * Validate flow (openspec factory-flow-step-options, D8): the flow loaded
   * exactly as an admitted run of this factory would load it now (default
   * branch at its head, prompt files, the factory checks, its step overrides
   * and the project's defaults), and its summary or every problem. Reads only:
   * no run, no thread. Without a factory, the built-ins only.
   */
  async function validateFlow(
    factoryId: string | null,
    projectId: string,
    flowName: string,
  ): Promise<Result<FactoryFlowValidation, FactoryQueueError>> {
    const factory = factoryId ? await loadFactory(factoryId) : null;
    const context = {
      overrides: factory?.stepOverrides ?? {},
      project: await projectAgentDefaults(projectId),
    };
    const where = factoryId ? await readerOf(factoryId) : null;
    const reads = where
      ? flowReadsOf(where.port, where.reader)
      : { readDefaultBranchFile: () => okAsync<string | null, GithubCallError>(null) };
    const flow = await loadFactoryFlow(flowName, reads, context);
    if (flow.isErr()) {
      if (flow.error.kind === 'unavailable') return err(flowRefusal(flow.error));
      const problems = flow.error.problems ?? [
        { step: 'flow', field: 'flow', message: flow.error.message },
      ];
      return ok({ ok: false, message: flow.error.message, problems });
    }
    const summary = summarizeFactoryFlow(flow.value.workflow, context);
    return ok({
      ok: true,
      name: flow.value.name,
      source: flow.value.source,
      commit: flow.value.commit,
      ...summary,
    });
  }

  async function blockers(
    factoryId: string,
    issueNumbers: number[],
  ): Promise<Result<FactoryIssueBlockers[], FactoryQueueError>> {
    const where = await readerOf(factoryId);
    if (!where) return ok([]);
    const all = await runs.list(factoryId);
    if (all.isErr()) return err({ kind: 'storage', message: all.error.message });
    // A blocker is in the factory while it has a run that has not failed or been stopped.
    const inFactory = new Set(
      all.value
        .filter(
          (run) => run.state !== 'failed' && run.state !== 'stopped' && run.state !== 'no_change',
        )
        .map((run) => run.issueNumber),
    );
    const answers: FactoryIssueBlockers[] = [];
    for (const issue of [...new Set(issueNumbers)]) {
      const read = await where.port.issueBlockers(where.reader, issue);
      const open = read.isOk()
        ? read.value.filter((b) => b.open && b.repo === where.reader.repo)
        : [];
      answers.push({
        issue,
        blockers: open.map((b) => ({ issue: b.number, inFactory: inFactory.has(b.number) })),
      });
    }
    return ok(answers);
  }

  return {
    submit: (factoryId: string, input: { issueNumbers: number[]; flowName: string }) =>
      new ResultAsync(submit(factoryId, input)),

    flows: (factoryId: string) => ResultAsync.fromSafePromise(flows(factoryId)),

    flowDefinition: (factoryId: string | null, flowName: string) =>
      new ResultAsync(flowDefinition(factoryId, flowName)),

    blockers: (factoryId: string, issueNumbers: number[]) =>
      new ResultAsync(blockers(factoryId, issueNumbers)),

    validateFlow: (factoryId: string | null, projectId: string, flowName: string) =>
      new ResultAsync(validateFlow(factoryId, projectId, flowName)),

    /** Remove every waiting issue from the queue; runs in progress go on. */
    clearQueue(factoryId: string): ResultAsync<FactoryQueueClearResult, FactoryQueueError> {
      return runs
        .cancel(factoryId)
        .mapErr((e): FactoryQueueError => ({ kind: 'storage', message: e.message }))
        .map((ids) => ({ cleared: ids.length, stopped: 0 }));
    },

    /** Clear the queue, then stop every run in progress and its threads. */
    stopAll(
      userId: string,
      factoryId: string,
    ): ResultAsync<FactoryQueueClearResult, FactoryQueueError> {
      const storage = (e: { message: string }): FactoryQueueError => ({
        kind: 'storage',
        message: e.message,
      });
      return runs
        .cancel(factoryId)
        .mapErr(storage)
        .andThen((cleared) =>
          runs
            .inFlight(factoryId)
            .mapErr(storage)
            .andThen((inFlight) =>
              ResultAsync.fromSafePromise(
                Promise.all(inFlight.map((run) => control.stop(userId, factoryId, run.id))),
              ),
            )
            .andThen((results) => stoppedCount(results).mapErr(storage))
            .map((stopped) => ({ cleared: cleared.length, stopped })),
        );
    },
  };
}
