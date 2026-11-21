import type { ActivityResultRef } from '@funny/shared';
/**
 * @domain subdomain: Activities
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: RemoteDataChannel, WSBroker
 *
 * Reports the background operations a user starts (clone, worktree setup, git
 * workflow) to the server as activities (track-background-activities, design D8).
 *
 * - `trackActivity(spec, run)` wraps an operation that returns a `Result`; an
 *   `err` or a throw ends the activity `failed` with the message.
 * - `beginActivity(spec)` is the imperative form for code that ends elsewhere.
 *
 * Reporting never blocks or fails the operation: reports of one activity are
 * sent in order in the background, a refused or failed report is logged, and
 * only the terminal report is retried (with backoff) while the runner is
 * disconnected, since it is the one write that must land. The tracker keeps
 * the ids it is running for reconciliation on (re)connect (design D4).
 *
 * To add a kind: declare it in `@funny/shared/activities`, wrap the operation
 * here, and add its retry target in the client's `lib/activity-retry.ts`.
 */
import type { ActivityKind } from '@funny/shared/activities';
import { Effect, Schedule } from 'effect';
import type { Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { sendRemoteData } from './remote-data-channel.js';
import { wsBroker } from './ws-broker.js';

export interface ActivitySpec {
  /** Reuse an id the client already knows (the clone id); a new one otherwise. */
  id?: string;
  kind: ActivityKind;
  userId: string;
  projectId?: string | null;
  threadId?: string | null;
  title: string;
  /** Recorded after the server strips it to the kind's declared fields. */
  input: Record<string, unknown>;
}

export interface ActivityHandle {
  readonly id: string;
  /** Records the current step (persisted). */
  step(label: string): void;
  /** Shows a percentage to connected browsers (not persisted). */
  progress(percent: number): void;
  /** What the operation produced, reported with its success. */
  result(ref: ActivityResultRef): void;
  succeed(ref?: ActivityResultRef): void;
  fail(error: string): void;
}

export interface ActivityReporter {
  request(eventType: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface ActivityTrackerDeps {
  reporter?: ActivityReporter;
  emitToUser?: (userId: string, event: Record<string, unknown>) => void;
  /** Terminal report retries (exponential from `retryBaseMs`). */
  retryTimes?: number;
  retryBaseMs?: number;
  newId?: () => string;
}

const PROGRESS_INTERVAL_MS = 500;

/** A server answer that refuses the write (scope, ownership, unknown type). */
function isRefusal(response: unknown): boolean {
  return (
    !!response &&
    typeof response === 'object' &&
    (response as { success?: unknown }).success === false
  );
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function createActivityTracker(deps: ActivityTrackerDeps = {}) {
  const reporter: ActivityReporter = deps.reporter ?? {
    request: (eventType, payload) => sendRemoteData(eventType, payload),
  };
  const emitToUser =
    deps.emitToUser ??
    ((userId: string, event: Record<string, unknown>) =>
      wsBroker.emitToUser(userId, event as never));
  const retryTimes = deps.retryTimes ?? 8;
  const retryBaseMs = deps.retryBaseMs ?? 1_000;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const live = new Set<string>();
  const pendingTerminal = new Set<Promise<void>>();
  const abort = new AbortController();

  /** One report; logs and swallows every failure. */
  async function send(eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const response = await reporter.request(eventType, payload);
      if (isRefusal(response)) {
        log.warn('Activity report refused by the server', {
          namespace: 'activities',
          eventType,
          error: (response as { error?: unknown }).error,
        });
      }
    } catch (error) {
      log.warn('Activity report failed', {
        namespace: 'activities',
        eventType,
        error: messageOf(error),
      });
    }
  }

  /** The terminal report: retried with backoff on transport errors, never on a refusal. */
  function sendTerminal(payload: Record<string, unknown>): Promise<void> {
    const attempt = Effect.tryPromise({
      try: () => reporter.request('data:activity_update', payload),
      catch: (error) => error,
    });
    const program = Effect.retry(attempt, {
      schedule: Schedule.exponential(retryBaseMs),
      times: retryTimes,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.sync(() => {
          if (isRefusal(response)) {
            log.warn('Activity outcome refused by the server', {
              namespace: 'activities',
              id: payload.id,
              error: (response as { error?: unknown }).error,
            });
          }
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() =>
          log.error('Activity outcome was not recorded', {
            namespace: 'activities',
            id: payload.id,
            error: messageOf(error),
          }),
        ),
      ),
    );
    return Effect.runPromise(program, { signal: abort.signal }).then(
      () => undefined,
      () => {
        log.warn('Activity outcome report stopped', { namespace: 'activities', id: payload.id });
      },
    );
  }

  function beginActivity(spec: ActivitySpec): ActivityHandle {
    const id = spec.id ?? newId();
    live.add(id);
    // Reports of one activity go out in order, without holding up the operation.
    let chain: Promise<void> = send('data:activity_start', {
      id,
      kind: spec.kind,
      projectId: spec.projectId ?? undefined,
      threadId: spec.threadId ?? undefined,
      title: spec.title,
      input: spec.input,
    });
    const enqueue = (report: () => Promise<void>) => {
      chain = chain.then(report);
      return chain;
    };

    let resultRef: ActivityResultRef | undefined;
    let lastStep: string | null = null;
    let lastProgressAt = 0;
    let ended = false;

    const end = (patch: Record<string, unknown>) => {
      if (ended) return;
      ended = true;
      const done = enqueue(() => sendTerminal({ id, patch })).finally(() => {
        live.delete(id);
        pendingTerminal.delete(done);
      });
      pendingTerminal.add(done);
    };

    return {
      id,
      step(label) {
        if (ended || !label || label === lastStep) return;
        lastStep = label;
        void enqueue(() => send('data:activity_update', { id, patch: { step: label } }));
      },
      progress(percent) {
        if (ended || !Number.isFinite(percent)) return;
        const now = Date.now();
        if (now - lastProgressAt < PROGRESS_INTERVAL_MS && percent < 100) return;
        lastProgressAt = now;
        emitToUser(spec.userId, {
          type: 'activity:progress',
          threadId: '',
          data: { id, percent: Math.max(0, Math.min(100, Math.round(percent))) },
        });
      },
      result(ref) {
        resultRef = { ...resultRef, ...ref };
      },
      succeed(ref) {
        const finalRef = ref ? { ...resultRef, ...ref } : resultRef;
        const patch: Record<string, unknown> = { status: 'succeeded' };
        if (finalRef) patch.resultRef = finalRef;
        end(patch);
      },
      fail(error) {
        end({ status: 'failed', error: error || 'Failed' });
      },
    };
  }

  /**
   * Runs `run` as an activity and resolves to its result unchanged. An `err`,
   * or a `failureOf` message for an `ok` value, ends the activity `failed`; a
   * throw ends it `failed` and is rethrown.
   */
  async function trackActivity<T, E>(
    spec: ActivitySpec,
    run: (activity: ActivityHandle) => PromiseLike<Result<T, E>>,
    options: { failureOf?: (value: T) => string | null } = {},
  ): Promise<Result<T, E>> {
    const activity = beginActivity(spec);
    try {
      const result = await run(activity);
      if (result.isErr()) {
        activity.fail(messageOf(result.error));
      } else {
        const failure = options.failureOf?.(result.value) ?? null;
        if (failure) activity.fail(failure);
        else activity.succeed();
      }
      return result;
    } catch (error) {
      activity.fail(messageOf(error));
      throw error;
    }
  }

  /** Sends the ids still running; the server interrupts this runner's others. */
  function reconcile(): Promise<void> {
    return send('data:activity_reconcile', { liveIds: [...live] });
  }

  return {
    beginActivity,
    trackActivity,
    reconcile,
    liveIds: () => [...live],
    /** Resolves once every terminal report has landed or given up (tests, shutdown). */
    flush: async () => {
      await Promise.all([...pendingTerminal]);
    },
    /** Stops terminal report retries (shutdown). */
    stop: () => abort.abort(),
  };
}

const tracker = createActivityTracker();

export const beginActivity = tracker.beginActivity;
export const trackActivity = tracker.trackActivity;
export const reconcileActivities = tracker.reconcile;
