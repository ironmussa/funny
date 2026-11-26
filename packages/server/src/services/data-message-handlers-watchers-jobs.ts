/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 *
 * Executors for the runner → server data messages about agent watchers and
 * jobs, part of the dispatch table in `data-message-handlers.ts`. The same
 * guards apply: callers run the ownership and project-scope checks first.
 */

import type { JobPatch, WatcherPatch } from '@funny/shared/repositories';
import { z } from 'zod';

import { repos } from '../db/repos.js';
import { isNumber, isString } from '../lib/value-guards.js';
import type { DataMessageHandlers } from './data-message-handler-types.js';

// ── Watcher / job patch allow-lists ──────────────────────────────

/** A runner-sent patch's own fields (the decoded `Struct` of a watcher / job update). */
type PatchFields = ReadonlyMap<string, unknown>;

/** Keep `patch[key]` when it passes `ok`; drop it otherwise. */
function copyIf<K extends string, T>(
  out: Partial<Record<K, T>>,
  patch: PatchFields,
  key: K,
  ok: (v: unknown) => v is T,
): void {
  const value = patch.get(key);
  if (patch.has(key) && ok(value)) out[key] = value;
}
const isNum = (v: unknown): v is number => isNumber(v) && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStr = (v: unknown): v is string => isString(v);
/** A runner's watcher / job patch: an object of fields; any other value patches nothing. */
const runnerPatchSchema = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((fields): PatchFields => new Map(Object.entries(fields)));
type RunnerPatch = z.output<typeof runnerPatchSchema>;

/**
 * Fields a runner may change on its own watcher — never owner, thread, key,
 * or caps. Values are type-checked; anything else is dropped.
 */
function pickWatcherPatch(patch: RunnerPatch): WatcherPatch {
  const out: Partial<Record<keyof WatcherPatch, string | number>> = {};
  copyIf(out, patch, 'nextWakeAt', isNum);
  copyIf(out, patch, 'lastDelayMs', isNum);
  copyIf(out, patch, 'wakeCount', isNum);
  copyIf(out, patch, 'status', isStr);
  copyIf(out, patch, 'updatedAt', isStr);
  // SAFETY: the numeric fields passed `isNum`; `status` is any string the
  // runner sent, stored unchecked as it always was.
  return out as WatcherPatch;
}

/**
 * Fields a runner may change on its own job. `logPath`/`exitPath`/`command`/
 * `cwd` are fixed at insert (the victim-file-read primitive), and `userId`/
 * `threadId` are never re-assignable. `pid` stays patchable because the
 * ownership guard already restricts updates to the runner user's own jobs.
 */
function pickJobPatch(patch: RunnerPatch): JobPatch {
  const out: Partial<Record<keyof JobPatch, string | number | null>> = {};
  copyIf(out, patch, 'pid', isNumOrNull);
  copyIf(out, patch, 'status', isStr);
  copyIf(out, patch, 'exitCode', isNumOrNull);
  copyIf(out, patch, 'updatedAt', isStr);
  // SAFETY: `pid` / `exitCode` passed `isNumOrNull`; `status` is any string the
  // runner sent, stored unchecked as it always was.
  return out as JobPatch;
}

/**
 * Watcher/job ops that carry no entity are scoped to the runner's owner.
 * Without an owner (an empty id would mean "every user" to the list queries)
 * they never run — they return an empty list.
 */
const OWNER_SCOPED_LIST_FALLBACK = [] as const;

/** Dispatch entries for the watcher and job `data:*` types. */
export const WATCHER_JOB_DATA_HANDLERS: DataMessageHandlers = {
  // ── Agent watchers (deferred-wake "snooze") ──────────────────
  // Every op acts as the runner's owner: inserts force row.userId, updates go
  // through typed patch allow-lists, and lists are owner-scoped (never "all").
  // By-id and by-thread ops were already owner-checked by data-ownership.ts.
  'data:watcher_insert': async ({ ownerId, data }) => {
    await repos.watchers().insert({ ...data.payload.row, userId: ownerId });
    return { type: 'data:watcher_insert_response', ok: true };
  },
  'data:watcher_get': async ({ data }) => {
    const watcher = await repos.watchers().getById(data.payload.id);
    return { type: 'data:watcher_get_response', watcher: watcher ?? null };
  },
  'data:watcher_get_live_by_thread_key': async ({ data }) => {
    const watcher = await repos
      .watchers()
      .getLiveByThreadKey(data.payload.threadId, data.payload.key);
    return {
      type: 'data:watcher_get_live_by_thread_key_response',
      watcher: watcher ?? null,
    };
  },
  'data:watcher_list_pending': async ({ ownerId }) => ({
    type: 'data:watcher_list_pending_response',
    watchers: ownerId ? await repos.watchers().listPending(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_list_due': async ({ ownerId, data }) => ({
    type: 'data:watcher_list_due_response',
    watchers: ownerId
      ? await repos.watchers().listDue(data.payload.now, ownerId)
      : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_list_by_user': async ({ ownerId }) => ({
    type: 'data:watcher_list_by_user_response',
    watchers: ownerId ? await repos.watchers().listByUser(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_update': async ({ data }) => {
    // `applied: false` — the watcher is no longer in a status this write is legal from.
    const expected = data.payload.expectedNextWakeAt;
    const applied = await repos
      .watchers()
      .update(
        data.payload.id,
        pickWatcherPatch(runnerPatchSchema.parse(data.payload.patch)),
        isNum(expected) ? { expectedNextWakeAt: expected } : undefined,
      );
    return { type: 'data:watcher_update_response', ok: true, applied };
  },
  'data:watcher_delete_by_thread': async ({ data }) => {
    await repos.watchers().deleteByThread(data.payload.threadId);
    return { type: 'data:watcher_delete_by_thread_response', ok: true };
  },

  // ── Agent jobs ───────────────────────────────────────────────
  'data:job_insert': async ({ ownerId, data }) => {
    await repos.jobs().insert({ ...data.payload.row, userId: ownerId });
    return { type: 'data:job_insert_response', ok: true };
  },
  'data:job_get': async ({ data }) => {
    const job = await repos.jobs().getById(data.payload.id);
    return { type: 'data:job_get_response', job: job ?? null };
  },
  'data:job_list_running': async ({ ownerId }) => ({
    type: 'data:job_list_running_response',
    jobs: ownerId ? await repos.jobs().listRunning(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:job_list_by_user': async ({ ownerId }) => ({
    type: 'data:job_list_by_user_response',
    jobs: ownerId ? await repos.jobs().listByUser(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:job_update': async ({ data }) => {
    const applied = await repos
      .jobs()
      .update(data.payload.id, pickJobPatch(runnerPatchSchema.parse(data.payload.patch)));
    return { type: 'data:job_update_response', ok: true, applied };
  },
  'data:job_delete_by_thread': async ({ data }) => {
    await repos.jobs().deleteByThread(data.payload.threadId);
    return { type: 'data:job_delete_by_thread_response', ok: true };
  },
};
