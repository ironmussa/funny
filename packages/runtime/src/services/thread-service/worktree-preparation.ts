/**
 * @domain subdomain: Thread Management
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: Worktree, WorktreeSetup, Telemetry
 *
 * Prepares a thread's worktree (checkout, then ports / .env / postCreate
 * commands) and measures it. Every flow that gives a thread a new worktree
 * goes through here: a new worktree thread, an idle worktree thread that
 * starts, and a local thread converted to a worktree.
 *
 * Telemetry (Abbacchio, channel funny-runtime), one trace per preparation:
 * - span `worktree.prepare` (attrs: flow, outcome, `worktree.root_configured`,
 *   `create.ms`, `post_create.ms`, `post_create.errors`)
 *   - span `worktree.create` / `worktree.post_create` (the two phases)
 *   - span `worktree.setup.step` per progress step (attrs: step, label,
 *     status), e.g. `worktree:create`, `ports`, `cmd:bun install`
 * - histograms `worktree.prepare.duration` (flow, outcome) and
 *   `worktree.setup.step.duration` (step, flow, status), in ms.
 */

import { configuredWorktreeRoot, createWorktree } from '@funny/core/git';
import { setupWorktree, type SetupProgressFn } from '@funny/core/ports';
import type { DomainError } from '@funny/shared/errors';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { recordHistogram, startSpan, type SpanHandle } from '../../lib/telemetry.js';
import { trackActivity } from '../activity-tracker.js';
import { createSetupProgressEmitter } from './helpers.js';

export type WorktreeFlow = 'create' | 'idle-start' | 'convert';

export interface PrepareWorktreeParams {
  projectPath: string;
  branchName: string;
  baseBranch?: string;
  /** Start from `origin/<baseBranch>`, fetched first (see `createWorktree`). */
  baseFromRemote?: boolean;
  /** Check out `branchName` when it exists already (see `createWorktree`). */
  reuseExistingBranch?: boolean;
  userId: string;
  threadId: string;
  flow: WorktreeFlow;
  /** The thread's project, recorded on its activity. */
  projectId?: string;
}

type SetupResult = Awaited<ReturnType<typeof setupWorktree>>;

/** Longest error text kept on a span (stderr of a failed command can be huge). */
const MAX_ERROR_CHARS = 500;

/**
 * Create the worktree and run its setup. Resolves to the worktree path, or the
 * checkout error. Setup problems (ports, postCreate commands) are logged and
 * never block the thread, as before. An unexpected throw propagates so the
 * caller marks the thread failed.
 */
export async function prepareWorktree(
  params: PrepareWorktreeParams,
): Promise<Result<string, DomainError>> {
  // Tracked as an activity (track-background-activities): a failed postCreate
  // command fails the activity, though the thread still gets its worktree.
  let setupErrors: string[] = [];
  return trackActivity(
    {
      kind: 'worktree.setup',
      userId: params.userId,
      projectId: params.projectId,
      threadId: params.threadId,
      title: activityTitle(params.flow, params.branchName),
      input: { branch: params.branchName, baseBranch: params.baseBranch },
    },
    (activity) =>
      runPreparation(
        params,
        (label) => activity.step(label),
        (errors) => (setupErrors = errors),
      ),
    {
      failureOf: () =>
        setupErrors.length > 0 ? `Setup failed: ${setupErrors.join('; ').slice(0, 2000)}` : null,
    },
  );
}

/** A conversion is its own action in the activity panel, not a plain setup. */
export function activityTitle(flow: WorktreeFlow, branchName: string): string {
  return flow === 'convert'
    ? `Convert thread to worktree ${branchName}`
    : `Set up worktree ${branchName}`;
}

async function runPreparation(
  params: PrepareWorktreeParams,
  onStep: (label: string) => void,
  onSetupErrors: (errors: string[]) => void,
): Promise<Result<string, DomainError>> {
  const { projectPath, branchName, baseBranch, reuseExistingBranch, userId, threadId, flow } =
    params;
  const root = startSpan('worktree.prepare', {
    attributes: {
      'thread.id': threadId,
      flow,
      'worktree.root_configured': configuredWorktreeRoot() !== null,
    },
  });
  const steps = createStepRecorder(root, flow);
  const emitToUser = createSetupProgressEmitter(userId, threadId);
  const onProgress: SetupProgressFn = (step, label, status, error) => {
    steps.record(step, label, status, error);
    emitToUser(step, label, status, error);
    if (status === 'running') onStep(label);
  };

  let outcome: 'ok' | 'create_failed' | 'error' = 'error';
  try {
    const created = await runPhase(root, 'create', () =>
      createWorktree(projectPath, branchName, baseBranch, onProgress, {
        reuseExistingBranch,
        fromRemote: params.baseFromRemote,
      }),
    );
    if (created.isErr()) {
      outcome = 'create_failed';
      return err(created.error);
    }
    const worktreePath = created.value;
    const setup = await runPhase(root, 'post_create', () =>
      setupWorktree(projectPath, worktreePath, onProgress),
    );
    root.attributes['post_create.errors'] = setup.isOk() ? setup.value.postCreateErrors.length : 0;
    onSetupErrors(setup.isOk() ? setup.value.postCreateErrors.map(String) : []);
    logSetupProblems(threadId, flow, setup);
    outcome = 'ok';
    return ok(worktreePath);
  } finally {
    steps.endUnfinished();
    root.attributes.outcome = outcome;
    root.end(outcome === 'ok' ? 'ok' : 'error');
    recordHistogram('worktree.prepare.duration', root.durationMs, {
      unit: 'ms',
      attributes: { flow, outcome },
    });
    log.info('Worktree preparation finished', {
      namespace: 'worktree',
      threadId,
      flow,
      outcome,
      durationMs: root.durationMs,
      createMs: root.attributes['create.ms'],
      postCreateMs: root.attributes['post_create.ms'],
    });
  }
}

/** Run one phase as a child span of `root` and record its duration on `root`. */
async function runPhase<T, E>(
  root: SpanHandle,
  phase: 'create' | 'post_create',
  run: () => PromiseLike<Result<T, E>>,
): Promise<Result<T, E>> {
  const span = startSpan(`worktree.${phase}`, {
    traceId: root.traceId,
    parentSpanId: root.spanId,
    attributes: { 'thread.id': root.attributes['thread.id'] },
  });
  try {
    const result = await run();
    span.end(result.isOk() ? 'ok' : 'error');
    return result;
  } catch (error) {
    span.end('error', truncate(String(error)));
    throw error;
  } finally {
    root.attributes[`${phase}.ms`] = span.durationMs;
  }
}

/** One child span per progress step, opened on `running`, closed on completed / failed. */
function createStepRecorder(root: SpanHandle, flow: WorktreeFlow) {
  const open = new Map<string, SpanHandle>();

  const finish = (step: string, status: 'completed' | 'failed' | 'unfinished', error?: string) => {
    const span = open.get(step);
    if (!span) return;
    open.delete(step);
    span.attributes.status = status;
    span.end(status === 'completed' ? 'ok' : 'error', error ? truncate(error) : undefined);
    recordHistogram('worktree.setup.step.duration', span.durationMs, {
      unit: 'ms',
      attributes: { step, flow, status },
    });
  };

  return {
    record(step: string, label: string, status: string, error?: string) {
      if (status === 'running') {
        // A repeated `running` for the same step restarts its measurement.
        finish(step, 'unfinished');
        open.set(
          step,
          startSpan('worktree.setup.step', {
            traceId: root.traceId,
            parentSpanId: root.spanId,
            attributes: { 'thread.id': root.attributes['thread.id'], flow, step, label },
          }),
        );
        return;
      }
      if (status === 'completed' || status === 'failed') finish(step, status, error);
    },
    /** Steps still running when the preparation ends (a throw, or a step with no end event). */
    endUnfinished() {
      for (const step of [...open.keys()]) finish(step, 'unfinished');
    },
  };
}

function logSetupProblems(threadId: string, flow: WorktreeFlow, setup: SetupResult): void {
  if (setup.isErr()) {
    log.warn('Failed to setup worktree', {
      namespace: 'worktree',
      threadId,
      flow,
      error: setup.error.message,
    });
    return;
  }
  const { postCreateErrors } = setup.value;
  if (postCreateErrors.length) {
    log.warn('Worktree postCreate errors', {
      namespace: 'worktree',
      threadId,
      flow,
      errors: postCreateErrors,
    });
  }
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
