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
  FactoryIssueBlockers,
  FactoryQueueCiProposal,
  FactoryQueueClearResult,
  FactoryReadiness,
  FactoryRunRoute,
  FactorySubmitResult,
  FactoryTrigger,
} from '@funny/shared/contracts/factory';
import { MAX_FACTORY_TRIGGERS } from '@funny/shared/contracts/factory';
import { errorMessage } from '@funny/shared/errors';
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { scheduleProblem } from '../schedules.js';
import {
  createFactoryBatchesRepository,
  type FactoryBatchesRepository,
} from './factory-batches.js';
import { flowReadsOf, loadFactoryFlow } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssueDetail, FactoryRepoReader } from './factory-github.js';
import { createFactoryQueueFlows, flowRefusal, NOT_RUNNING_HERE } from './factory-queue-flows.js';
import { ciRunsOnQueueBranches, readWorkflowFiles } from './factory-readiness.js';
import { createFactoryRunControl, releaseStoppedIssue } from './factory-run-control.js';
import { createFactoryRunsRepository, type FactoryRunView } from './factory-runs.js';
import { getWatchedFactory, type WatchedFactory } from './factory-settings.js';
import {
  createFactoryTriggersRepository,
  type FactoryTriggersRepository,
  type SaveTriggerInput,
} from './factory-triggers.js';
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
  /** A trigger or a start that cannot be accepted as written (schedule, input, limit). */
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

export interface FactoryQueueDeps {
  runs?: ReturnType<typeof createFactoryRunsRepository>;
  batches?: Pick<FactoryBatchesRepository, 'ciDurations'>;
  control?: Pick<ReturnType<typeof createFactoryRunControl>, 'stop' | 'retry'>;
  /** The watcher's GitHub side; null when the watcher is not running here. */
  github?: () => FactoryGithubPort | null;
  /** The live target check; null when the watcher is not running here. */
  target?: (factory: WatchedFactory) => Promise<FactoryTarget | null>;
  factory?: (factoryId: string) => Promise<WatchedFactory | null>;
  /** Look at the factory now instead of at its next poll. */
  wake?: (factoryId: string) => Promise<void>;
  triggers?: FactoryTriggersRepository;
  /** Take the factory's label off the issue of a labelled run taken out of the queue. */
  releaseIssue?: (run: FactoryRunView) => Promise<void>;
}

/** The issue that asks for CI on the merge queue's branches (D12), as the implementer reads it. */
const QUEUE_CI_ISSUE = {
  title: "Run CI on the factory merge queue's branches",
  body: [
    "funny's issue factory merges pull requests in batches: it merges several of them onto a `factory/queue/<id>` branch and lets CI test that branch once. CI does not run on pushes to those branches in this repository yet, so the factory merges one pull request at a time.",
    '',
    'Change the GitHub Actions workflow(s) that run the checks pull requests need so they also run on pushes to `factory/queue/**`:',
    '',
    '```yaml',
    'on:',
    '  push:',
    "    branches: ['factory/queue/**']",
    '```',
    '',
    'Keep every trigger the workflows have now (pull requests, the default branch). Do not add deploys or other side effects to those pushes: a queue branch is a test, never a release. Do not change branch protection or rulesets.',
  ].join('\n'),
};

/** A token refusal (App missing, not installed, no access): the whole send fails, not one issue. */
const isTokenRefusal = (error: GithubCallError) => error.status === undefined && !!error.kind;

type Refusal = FactorySubmitResult['refused'][number];

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

/** Create or change a schedule trigger of the factory (change flow-triggers). */
async function saveTrigger(
  triggers: FactoryTriggersRepository,
  issuelessRefusal: (
    factoryId: string,
    flowName: string,
    inputs: Record<string, string>,
  ) => Promise<FactoryQueueError | null>,
  factoryId: string,
  input: Omit<SaveTriggerInput, 'factoryId'>,
): Promise<Result<FactoryTrigger, FactoryQueueError>> {
  const problem = scheduleProblem(input.schedule);
  if (problem) return err({ kind: 'invalid', message: `Invalid schedule: ${problem}` });
  const refusal = await issuelessRefusal(factoryId, input.flowName, input.inputs);
  if (refusal) return err(refusal);
  if (!input.id) {
    const existing = await triggers.list(factoryId);
    if (existing.isErr()) return err({ kind: 'storage', message: existing.error.message });
    if (existing.value.length >= MAX_FACTORY_TRIGGERS) {
      return err({
        kind: 'invalid',
        message: `A factory has at most ${MAX_FACTORY_TRIGGERS} schedule triggers.`,
      });
    }
  }
  const saved = await triggers.save({ ...input, factoryId });
  if (saved.isErr()) return err({ kind: 'storage', message: saved.error.message });
  if (!saved.value) return err({ kind: 'not-found', message: 'Trigger not found' });
  return ok(saved.value);
}

/** The route a send asked for, or null when it names no branch (the factory's settings). */
function usedRoute(route: FactoryRunRoute | undefined): FactoryRunRoute | null {
  if (!route) return null;
  const lane =
    route.lane && (route.lane.baseBranch || route.lane.finishBranch) ? route.lane : undefined;
  return route.baseBranch || lane ? { baseBranch: route.baseBranch, lane } : null;
}

/**
 * Why a send's route cannot be used, or null: every branch it names must exist
 * on GitHub now (change factory-lanes, D13), so a mistyped branch is refused
 * at the send, not found by a run that cannot start.
 */
async function missingRouteBranch(
  port: FactoryGithubPort,
  reader: FactoryRepoReader,
  route: FactoryRunRoute | null,
): Promise<string | null> {
  if (!route) return null;
  const named = [route.baseBranch, route.lane?.baseBranch, route.lane?.finishBranch];
  const branches = [...new Set(named.filter((name): name is string => Boolean(name)))];
  if (!port.laneBranches) return NOT_RUNNING_HERE;
  for (const branch of branches) {
    const head = await port.laneBranches(reader).branchHead(branch);
    if (head.isErr()) return `GitHub could not be read: ${head.error.message}`;
    if (!head.value) return `The branch ${branch} does not exist on GitHub.`;
  }
  return null;
}

/** The route a send may use: null when it names no branch, refused when one does not exist. */
async function checkedRoute(
  port: FactoryGithubPort,
  reader: FactoryRepoReader,
  asked: FactoryRunRoute | undefined,
): Promise<Result<FactoryRunRoute | null, FactoryQueueError>> {
  const route = usedRoute(asked);
  const missing = await missingRouteBranch(port, reader, route);
  return missing ? err({ kind: 'invalid', message: missing }) : ok(route);
}

/** The issues of a send that may be queued, and the ones refused with why; each number once. */
async function sendableIssues(
  port: Pick<FactoryGithubPort, 'getIssue'>,
  reader: FactoryRepoReader,
  numbers: readonly number[],
): Promise<
  Result<{ open: FactoryIssueDetail[]; refused: FactorySubmitResult['refused'] }, FactoryQueueError>
> {
  const refused: FactorySubmitResult['refused'] = [];
  const open: FactoryIssueDetail[] = [];
  for (const number of new Set(numbers)) {
    const checked = sendable(number, await port.getIssue(reader, number));
    if (checked.isErr()) return err(checked.error);
    if ('refusal' in checked.value) refused.push(checked.value.refusal);
    else open.push(checked.value.issue);
  }
  return ok({ open, refused });
}

export function createFactoryQueue(deps: FactoryQueueDeps = {}) {
  const runs = deps.runs ?? createFactoryRunsRepository();
  const batches = deps.batches ?? createFactoryBatchesRepository();
  const control = deps.control ?? createFactoryRunControl(runs);
  const github = deps.github ?? factoryGithubPort;
  const target = deps.target ?? checkFactoryTarget;
  const loadFactory = deps.factory ?? getWatchedFactory;
  const wake = deps.wake ?? pokeFactory;
  const triggers = deps.triggers ?? createFactoryTriggersRepository();
  const release = deps.releaseIssue ?? releaseStoppedIssue;
  const {
    readerOf,
    flows,
    flowDefinition,
    readiness,
    validateFlow,
    issuelessFlow,
    issuelessRefusal,
  } = createFactoryQueueFlows({ runs, batches, github, target, loadFactory });

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
    input: { issueNumbers: number[]; flowName: string; route?: FactoryRunRoute },
  ): Promise<Result<FactorySubmitResult, FactoryQueueError>> {
    const ready = await workingFactory(factoryId);
    if (ready.isErr()) return err(ready.error);
    const { port, reader } = ready.value;
    const route = await checkedRoute(port, reader, input.route);
    if (route.isErr()) return err(route.error);

    const flow = await loadFactoryFlow(input.flowName, flowReadsOf(port, reader));
    if (flow.isErr()) return err(flowRefusal(flow.error));

    const issues = await sendableIssues(port, reader, input.issueNumbers);
    if (issues.isErr()) return err(issues.error);
    const { open, refused } = issues.value;

    const ordered = oldestFirst(open);
    if (ordered.length === 0) return ok({ accepted: [], refused });

    const queued = await runs.enqueue({
      factoryId,
      issueNumbers: ordered,
      issueTitles: new Map(open.map((issue) => [issue.number, issue.title])),
      flowName: input.flowName,
      route: route.value,
    });
    if (queued.isErr()) return err({ kind: 'storage', message: queued.error.message });
    const accepted = queued.value.queued.flatMap((run) =>
      run.issueNumber === null ? [] : [run.issueNumber],
    );
    if (accepted.length > 0) wakeFactory(factoryId);
    return ok({ accepted, refused: [...refused, ...queued.value.duplicates.map(alreadyIn)] });
  }

  /**
   * Take every waiting run out of the queue; the ids taken out. An issue the
   * factory queued by its label loses the label, as a stopped run's does, so
   * the next poll does not queue it again.
   */
  function emptyQueue(factoryId: string) {
    return runs.queue(factoryId).andThen((waiting) =>
      runs.cancel(factoryId).andThen((ids) => {
        const taken = new Set(ids);
        const released = waiting.filter((run) => taken.has(run.id)).map(release);
        return ResultAsync.fromSafePromise(Promise.all(released)).map(() => ids);
      }),
    );
  }

  /** Look at the factory now instead of at its next poll; best-effort. */
  function wakeFactory(factoryId: string): void {
    void wake(factoryId).catch((cause: unknown) =>
      log.error('Issue factory poke failed', {
        namespace: 'factory',
        factoryId,
        error: errorMessage(cause),
      }),
    );
  }

  /**
   * Open the issue that asks for CI on the queue's branches, with the App
   * token capped by `userId`'s own access, and send it to the factory as a
   * normal run (D12). The factory opens the pull request; nothing edits a
   * workflow or a branch rule here.
   */
  async function proposeQueueCi(
    userId: string,
    factoryId: string,
  ): Promise<Result<FactoryQueueCiProposal, FactoryQueueError>> {
    const ready = await workingFactory(factoryId);
    if (ready.isErr()) return err(ready.error);
    const { factory, port, reader } = ready.value;
    const workflows = await readWorkflowFiles(port, reader);
    if (workflows === null) {
      return err({ kind: 'cannot-work', message: "The repository's workflows could not be read." });
    }
    if (ciRunsOnQueueBranches(workflows)) {
      return err({
        kind: 'cannot-work',
        message: "CI already runs on the merge queue's branches.",
      });
    }
    if (!port.createIssue) return err({ kind: 'cannot-work', message: NOT_RUNNING_HERE });
    const opened = await port.createIssue({ ...reader, ownerId: userId }, QUEUE_CI_ISSUE);
    if (opened.isErr()) {
      return err({
        kind: 'cannot-work',
        message: `The issue could not be opened: ${opened.error.message}`,
      });
    }
    const { number, url } = opened.value;
    const sent = await submit(factoryId, { issueNumbers: [number], flowName: factory.flowName });
    if (sent.isErr())
      return ok({ issueNumber: number, url, queued: false, reason: sent.error.message });
    const refused = sent.value.refused[0];
    return ok(
      sent.value.accepted.includes(number)
        ? { issueNumber: number, url, queued: true }
        : { issueNumber: number, url, queued: false, reason: refused?.message ?? 'Not queued.' },
    );
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

  /** Start one run of a flow now, without an issue (change flow-triggers). */
  async function runFlow(
    factoryId: string,
    input: { flowName: string; inputs: Record<string, string> },
  ): Promise<Result<FactoryRunView, FactoryQueueError>> {
    const ready = await workingFactory(factoryId);
    if (ready.isErr()) return err(ready.error);
    const refusal = await issuelessRefusal(factoryId, input.flowName, input.inputs);
    if (refusal) return err(refusal);
    const queued = await runs.enqueueIssueless({
      factoryId,
      flowName: input.flowName,
      source: 'run_now',
      inputs: input.inputs,
    });
    if (queued.isErr()) return err({ kind: 'storage', message: queued.error.message });
    // No trigger id: the one-run-per-trigger index never refuses a run a member starts.
    if (!queued.value) return err({ kind: 'storage', message: 'The run could not be queued.' });
    wakeFactory(factoryId);
    return ok(queued.value);
  }

  const triggerStorage = (e: { message: string }): FactoryQueueError => ({
    kind: 'storage',
    message: e.message,
  });

  return {
    submit: (
      factoryId: string,
      input: { issueNumbers: number[]; flowName: string; route?: FactoryRunRoute },
    ) => new ResultAsync(submit(factoryId, input)),

    issuelessFlow: (factoryId: string | null, flowName: string) =>
      new ResultAsync(issuelessFlow(factoryId, flowName)),

    runFlow: (factoryId: string, input: { flowName: string; inputs: Record<string, string> }) =>
      new ResultAsync(runFlow(factoryId, input)),

    triggers: (factoryId: string) => triggers.list(factoryId).mapErr(triggerStorage),

    saveTrigger: (factoryId: string, input: Omit<SaveTriggerInput, 'factoryId'>) =>
      new ResultAsync(saveTrigger(triggers, issuelessRefusal, factoryId, input)),

    removeTrigger: (factoryId: string, triggerId: string) =>
      triggers
        .remove(factoryId, triggerId)
        .mapErr(triggerStorage)
        .andThen((removed) =>
          removed
            ? okAsync(undefined)
            : errAsync<undefined, FactoryQueueError>({
                kind: 'not-found',
                message: 'Trigger not found',
              }),
        ),

    flows: (factoryId: string) => ResultAsync.fromSafePromise(flows(factoryId)),

    flowDefinition: (factoryId: string | null, flowName: string) =>
      new ResultAsync(flowDefinition(factoryId, flowName)),

    blockers: (factoryId: string, issueNumbers: number[]) =>
      new ResultAsync(blockers(factoryId, issueNumbers)),

    readiness: (factoryId: string | null): ResultAsync<FactoryReadiness, FactoryQueueError> =>
      ResultAsync.fromSafePromise(readiness(factoryId)),

    proposeQueueCi: (userId: string, factoryId: string) =>
      new ResultAsync(proposeQueueCi(userId, factoryId)),

    validateFlow: (
      factoryId: string | null,
      projectId: string,
      flowName: string,
      options?: { userId?: string; requireRepo?: boolean },
    ) => new ResultAsync(validateFlow(factoryId, projectId, flowName, options)),

    /** Remove every waiting issue from the queue; runs in progress go on. */
    clearQueue(factoryId: string): ResultAsync<FactoryQueueClearResult, FactoryQueueError> {
      return emptyQueue(factoryId)
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
      return emptyQueue(factoryId)
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
