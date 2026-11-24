/**
 * @domain subdomain: Activities
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityRepository, BrowserEvents
 *
 * Activities the server runs itself (track-funny-actions, design D7): the
 * server's counterpart of the runner's `activity-tracker.ts`, over the same
 * repository, machine and broadcast. Rows have no runner (`runner_id` NULL), so
 * no runner report can match them, and they are interrupted at server start.
 *
 * - `trackServerActivity(spec, run)` wraps an operation that returns a `Result`.
 * - `beginServerActivity(spec)` is the imperative form.
 * `serverActivities` is the shared instance (stateless: it reads the
 * repository on each write); tests build their own with `createServerActivities`.
 * - `recordServerActivity(spec, outcome)` writes an instant action in one row.
 *
 * A kind declared `on-failure` writes nothing until it fails, then one finished
 * row. `spec.userId` is the user the action was taken for, read by the caller
 * from stored state (thread owner, sandbox row owner, factory enabler, project
 * owner), never from a request. Recording never fails the action: a write
 * failure is logged.
 */
import type { Activity, ActivityEffect, ActivityOrigin, ActivityResultRef } from '@funny/shared';
import {
  ACTIVITY_EFFECTS_MAX,
  ACTIVITY_ERROR_MAX,
  ACTIVITY_STEP_MAX,
  ACTIVITY_TITLE_MAX,
  type ActivityKind,
  parseActivityEffects,
  parseActivityInput,
  recordsOnlyFailures,
} from '@funny/shared/activities';
import type { ActivityInsert, ActivityRepository } from '@funny/shared/repositories';
import type { Result } from 'neverthrow';

import { repos } from '../../db/repos.js';
import { log } from '../../lib/logger.js';
import { broadcastActivitiesRemoved, broadcastActivity } from './activity-service.js';

export interface ServerActivitySpec {
  kind: ActivityKind;
  /** The user the action was taken for, from stored state. */
  userId: string;
  projectId?: string | null;
  threadId?: string | null;
  title: string;
  input: Record<string, unknown>;
  origin: ActivityOrigin;
}

export interface ServerActivityHandle {
  readonly id: string;
  step(label: string): void;
  /** Records one thing the action changed; sent with the next write. */
  effect(effect: ActivityEffect['effect'], target: string): void;
  succeed(ref?: ActivityResultRef): void;
  fail(error: string): void;
  /** Resolves once every write of this activity has landed or been logged. */
  settled(): Promise<void>;
}

export type ServerActivityOutcome =
  | { ok: true; effects?: ActivityEffect[]; resultRef?: ActivityResultRef }
  | { ok: false; error: string; effects?: ActivityEffect[] };

type Repo = Pick<ActivityRepository, 'insert' | 'update' | 'getById'>;

export interface ServerActivityDeps {
  repo?: () => Repo;
  broadcast?: (activity: Activity) => void;
  broadcastRemoved?: (userId: string, ids: string[]) => void;
  newId?: () => string;
}

function messageOf(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export function createServerActivities(deps: ServerActivityDeps = {}) {
  const repo = deps.repo ?? (() => repos.activities());
  const broadcast = deps.broadcast ?? broadcastActivity;
  const broadcastRemoved = deps.broadcastRemoved ?? broadcastActivitiesRemoved;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  /** Runs one write; logs and swallows any failure. */
  async function guarded(what: string, id: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      log.warn(`Server activity ${what} was not recorded`, {
        namespace: 'activities',
        id,
        error: messageOf(error),
      });
    }
  }

  async function broadcastRow(id: string): Promise<void> {
    const row = await repo().getById(id);
    if (row) broadcast(row);
  }

  /** The validated input, or null (logged) when it does not match the kind. */
  function inputOf(spec: ServerActivitySpec): Record<string, unknown> | null {
    const input = parseActivityInput(spec.kind, spec.input);
    if (!input) {
      log.warn('Server activity input does not match its kind', {
        namespace: 'activities',
        kind: spec.kind,
      });
    }
    return input;
  }

  async function insert(
    id: string,
    spec: ServerActivitySpec,
    input: Record<string, unknown>,
    final?: ServerActivityOutcome,
  ): Promise<void> {
    const row: ActivityInsert = {
      id,
      userId: spec.userId,
      runnerId: null,
      kind: spec.kind,
      projectId: spec.projectId ?? null,
      threadId: spec.threadId ?? null,
      title: clip(spec.title, ACTIVITY_TITLE_MAX) || spec.kind,
      input,
      origin: spec.origin,
      startedAt: new Date().toISOString(),
    };
    if (final) {
      row.status = final.ok ? 'succeeded' : 'failed';
      row.error = final.ok ? null : clip(final.error, ACTIVITY_ERROR_MAX) || 'Failed';
      row.effects = parseActivityEffects(final.effects ?? []);
      row.resultRef = final.ok ? (final.resultRef ?? null) : null;
    }
    const { inserted, capped } = await repo().insert(row);
    if (!inserted) return;
    await broadcastRow(id);
    broadcastRemoved(spec.userId, capped);
  }

  /** Records an instant action in one write; a successful `on-failure` kind records nothing. */
  async function recordServerActivity(
    spec: ServerActivitySpec,
    outcome: ServerActivityOutcome,
  ): Promise<void> {
    if (outcome.ok && recordsOnlyFailures(spec.kind)) return;
    const input = inputOf(spec);
    if (!input) return;
    const id = newId();
    await guarded('record', id, () => insert(id, spec, input, outcome));
  }

  function beginServerActivity(spec: ServerActivitySpec): ServerActivityHandle {
    const id = newId();
    const input = inputOf(spec);
    // An `on-failure` kind stays in memory until it fails.
    const deferred = recordsOnlyFailures(spec.kind);
    const effects: ActivityEffect[] = [];
    let ended = false;
    let lastStep: string | null = null;
    let chain: Promise<void> =
      input && !deferred ? guarded('start', id, () => insert(id, spec, input)) : Promise.resolve();

    const patch = (write: Parameters<Repo['update']>[1]) => {
      if (!input || deferred) return;
      chain = chain.then(() =>
        guarded('update', id, async () => {
          if (await repo().update(id, write, null)) await broadcastRow(id);
        }),
      );
    };

    const end = (outcome: ServerActivityOutcome) => {
      if (ended) return;
      ended = true;
      if (!input) return;
      if (deferred) {
        if (!outcome.ok) {
          chain = chain.then(() =>
            guarded('record', id, () => insert(id, spec, input, { ...outcome, effects })),
          );
        }
        return;
      }
      patch(
        outcome.ok
          ? {
              status: 'succeeded',
              effects: effects.length > 0 ? [...effects] : undefined,
              resultRef: outcome.resultRef,
              endedAt: new Date().toISOString(),
            }
          : {
              status: 'failed',
              error: clip(outcome.error, ACTIVITY_ERROR_MAX) || 'Failed',
              effects: effects.length > 0 ? [...effects] : undefined,
              endedAt: new Date().toISOString(),
            },
      );
    };

    return {
      id,
      step(label) {
        const value = clip(label, ACTIVITY_STEP_MAX);
        if (ended || !value || value === lastStep) return;
        lastStep = value;
        patch({ status: 'running', step: value });
      },
      effect(effect, target) {
        if (ended || effects.length >= ACTIVITY_EFFECTS_MAX) return;
        effects.push({ effect, target });
      },
      succeed(ref) {
        end({ ok: true, resultRef: ref });
      },
      fail(error) {
        end({ ok: false, error });
      },
      settled: () => chain,
    };
  }

  /**
   * Runs `run` as a server activity and resolves to its result unchanged. An
   * `err` or a throw ends it `failed` (a throw is rethrown).
   */
  async function trackServerActivity<T, E>(
    spec: ServerActivitySpec,
    run: (activity: ServerActivityHandle) => PromiseLike<Result<T, E>>,
  ): Promise<Result<T, E>> {
    const activity = beginServerActivity(spec);
    try {
      const result = await run(activity);
      if (result.isErr()) activity.fail(messageOf(result.error));
      else activity.succeed();
      return result;
    } catch (error) {
      activity.fail(messageOf(error));
      throw error;
    } finally {
      await activity.settled();
    }
  }

  return { beginServerActivity, trackServerActivity, recordServerActivity };
}

export type ServerActivities = ReturnType<typeof createServerActivities>;

export const serverActivities = createServerActivities();

export const recordServerActivity = serverActivities.recordServerActivity;

/**
 * Server start: every `running` server row was cut short by the restart and
 * becomes `interrupted`. Runner rows are left to their runner's reconcile.
 */
export async function interruptServerActivities(): Promise<number> {
  try {
    const changed = await repos.activities().interruptServerActivities();
    for (const row of changed) broadcastActivity(row);
    if (changed.length > 0) {
      log.info('Marked server activities interrupted at start', {
        namespace: 'activities',
        count: changed.length,
      });
    }
    return changed.length;
  } catch (error) {
    log.warn('Could not interrupt server activities at start', {
      namespace: 'activities',
      error: messageOf(error),
    });
    return 0;
  }
}
