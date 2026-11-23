import type { Activity, ActivityResultRef, ActivityStatus } from '@funny/shared';
/**
 * @domain subdomain: Activities
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityRepository, BrowserEvents
 *
 * Background activities (track-background-activities): the runner reports the
 * operations it runs through the data channel (`data:activity_*`), this module
 * records them and tells the owner's browsers. The user and runner of a row
 * always come from the authenticated runner session, never from the payload.
 */
import {
  ACTIVITY_ERROR_MAX,
  ACTIVITY_STEP_MAX,
  ACTIVITY_TITLE_MAX,
  isActivityOrigin,
  parseActivityEffects,
  parseActivityInput,
} from '@funny/shared/activities';
import { isFinalActivityStatus } from '@funny/shared/activity-machine';
import type { ActivityInsert, ActivityPatch } from '@funny/shared/repositories';

import { repos } from '../../db/repos.js';
import { log } from '../../lib/logger.js';
import { relayToUser } from '../browser-events.js';

const SNAPSHOT_REF = /^refs\/funny\/undo\/[A-Za-z0-9_-]{1,128}$/;
const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const REPORTED_STATUSES = new Set<ActivityStatus>(['running', 'succeeded', 'failed']);

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

/** Each field a reported result may carry, and how it is checked. */
const RESULT_REF_FIELDS: Array<[keyof ActivityResultRef, (v: string) => string | null]> = [
  ['projectId', (v) => (ID_PATTERN.test(v) ? v : null)],
  ['prUrl', (v) => (/^https?:\/\//.test(v) ? v.slice(0, 2048) : null)],
  // An undo snapshot's ref (track-user-and-scheduled-actions, design D6).
  ['snapshot', (v) => (SNAPSHOT_REF.test(v) ? v : null)],
];

function resultRefOf(value: unknown): ActivityResultRef | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const ref: ActivityResultRef = {};
  for (const [field, check] of RESULT_REF_FIELDS) {
    const given = raw[field];
    const kept = typeof given === 'string' ? check(given) : null;
    if (kept) ref[field] = kept;
  }
  return Object.keys(ref).length > 0 ? ref : null;
}

export function broadcastActivity(activity: Activity): void {
  relayToUser(activity.userId, { type: 'activity:updated', threadId: '', data: { activity } });
}

export function broadcastActivitiesRemoved(userId: string, ids: string[]): void {
  if (ids.length === 0) return;
  relayToUser(userId, { type: 'activity:removed', threadId: '', data: { ids } });
}

export type ActivityWriteResult = { ok: true; applied: boolean } | { ok: false; error: string };

/**
 * `data:activity_start`: inserts an activity for the runner's owner, `running`,
 * or already `succeeded` / `failed` for an instant action (track-funny-actions,
 * design D6), recorded and broadcast once.
 */
export async function startActivityFromRunner(args: {
  runnerId: string;
  ownerId: string;
  payload: Record<string, unknown>;
}): Promise<ActivityWriteResult> {
  const { runnerId, ownerId, payload } = args;
  const id = optionalId(payload.id);
  const kind = typeof payload.kind === 'string' ? payload.kind : '';
  const title = text(payload.title, ACTIVITY_TITLE_MAX);
  if (!id) return { ok: false, error: 'activity id is invalid' };
  if (!title) return { ok: false, error: 'activity title is required' };
  const input = parseActivityInput(kind, payload.input);
  if (!input) return { ok: false, error: `activity kind ${kind} or its input is invalid` };

  const finalStatus =
    payload.status === 'succeeded' || payload.status === 'failed' ? payload.status : undefined;
  const row: ActivityInsert = {
    id,
    userId: ownerId,
    runnerId,
    kind,
    projectId: optionalId(payload.projectId),
    threadId: optionalId(payload.threadId),
    title,
    input,
    step: text(payload.step, ACTIVITY_STEP_MAX),
    origin: isActivityOrigin(payload.origin) ? payload.origin : 'user',
    effects: parseActivityEffects(payload.effects),
    startedAt: new Date().toISOString(),
  };
  if (finalStatus) {
    row.status = finalStatus;
    row.error = finalStatus === 'failed' ? text(payload.error, ACTIVITY_ERROR_MAX) : null;
    row.resultRef = resultRefOf(payload.resultRef) ?? null;
  }
  const { inserted, capped } = await repos.activities().insert(row);
  if (inserted) {
    const stored = await repos.activities().getById(id);
    if (stored) broadcastActivity(stored);
    broadcastActivitiesRemoved(ownerId, capped);
  }
  return { ok: true, applied: inserted };
}

function reportedStatus(value: unknown): ActivityStatus | undefined {
  return typeof value === 'string' && REPORTED_STATUSES.has(value as ActivityStatus)
    ? (value as ActivityStatus)
    : undefined;
}

/** The fields a runner may change on its own activity; never `origin`. */
function pickActivityPatch(raw: unknown): ActivityPatch {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const patch: ActivityPatch = {};
  const status = reportedStatus(value.status);
  if (status) patch.status = status;
  if ('step' in value) patch.step = text(value.step, ACTIVITY_STEP_MAX);
  if ('error' in value) patch.error = text(value.error, ACTIVITY_ERROR_MAX);
  const resultRef = resultRefOf(value.resultRef);
  if (resultRef !== undefined) patch.resultRef = resultRef;
  if ('effects' in value) patch.effects = parseActivityEffects(value.effects);
  if (status && isFinalActivityStatus(status)) patch.endedAt = new Date().toISOString();
  return patch;
}

/**
 * `data:activity_update`: compare-and-set on the stored status AND on the
 * runner that started the row, so a runner cannot touch another runner's row.
 */
export async function updateActivityFromRunner(args: {
  runnerId: string;
  id: unknown;
  patch: unknown;
}): Promise<ActivityWriteResult> {
  const id = optionalId(args.id);
  if (!id) return { ok: false, error: 'activity id is invalid' };
  const patch = pickActivityPatch(args.patch);
  if (Object.keys(patch).length === 0) return { ok: true, applied: false };
  const applied = await repos.activities().update(id, patch, args.runnerId);
  if (applied) {
    const row = await repos.activities().getById(id);
    if (row) broadcastActivity(row);
  }
  return { ok: true, applied };
}

/** `data:activity_reconcile`: the runner's unlisted running rows become `interrupted`. */
export async function reconcileRunnerActivities(
  runnerId: string,
  liveIds: unknown,
): Promise<Activity[]> {
  const ids = Array.isArray(liveIds)
    ? liveIds.filter((v): v is string => typeof v === 'string' && ID_PATTERN.test(v))
    : [];
  const changed = await repos.activities().reconcile(runnerId, ids);
  for (const row of changed) broadcastActivity(row);
  if (changed.length > 0) {
    log.info('Marked activities interrupted on runner reconnect', {
      namespace: 'activities',
      runnerId,
      count: changed.length,
    });
  }
  return changed;
}

/** A deleted runner will never report again: its running rows become `interrupted`. */
export async function interruptActivitiesOfRunner(runnerId: string): Promise<Activity[]> {
  const changed = await repos.activities().interruptRunner(runnerId);
  for (const row of changed) broadcastActivity(row);
  return changed;
}
