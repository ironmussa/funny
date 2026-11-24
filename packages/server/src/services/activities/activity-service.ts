import type { Activity, ActivityResultRef } from '@funny/shared';
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
import { z } from 'zod';

import { repos } from '../../db/repos.js';
import { log } from '../../lib/logger.js';
import { relayToUser } from '../browser-events.js';

const SNAPSHOT_REF = /^refs\/funny\/undo\/[A-Za-z0-9_-]{1,128}$/;
const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;

/** A runner-reported text field, trimmed and clipped to `max`; blank or not a string → null. */
function textField(max: number) {
  return z
    .string()
    .transform((value) => value.trim().slice(0, max) || null)
    .nullable()
    .catch(null);
}
const titleText = textField(ACTIVITY_TITLE_MAX);
const stepText = textField(ACTIVITY_STEP_MAX);
const errorText = textField(ACTIVITY_ERROR_MAX);

/** A runner-reported id; anything that is not a well-formed id → null. */
const optionalId = z.string().regex(ID_PATTERN).nullable().catch(null);

/** The fields of a runner's activity object; any other value carries none. */
const runnerFieldsSchema = z.record(z.string(), z.unknown()).catch({});
type RunnerFields = z.output<typeof runnerFieldsSchema>;

/** A reported result: absent stays absent, an object is checked field by field, anything else → null. */
const resultRefInput = z.record(z.string(), z.unknown()).nullable().optional().catch(null);
type ResultRefInput = z.output<typeof resultRefInput>;

/** The statuses a runner may report on its own activity. */
const reportedStatus = z.enum(['running', 'succeeded', 'failed']).optional().catch(undefined);

/** The live activity ids of a reconnecting runner; malformed entries are dropped. */
export const liveActivityIdsSchema = z
  .array(z.unknown())
  .catch([])
  .transform((ids) => ids.filter((v): v is string => typeof v === 'string' && ID_PATTERN.test(v)));

/** Each field a reported result may carry, and how it is checked. */
const RESULT_REF_FIELDS: Array<[keyof ActivityResultRef, (v: string) => string | null]> = [
  ['projectId', (v) => (ID_PATTERN.test(v) ? v : null)],
  ['prUrl', (v) => (/^https?:\/\//.test(v) ? v.slice(0, 2048) : null)],
  // An undo snapshot's ref (track-user-and-scheduled-actions, design D6).
  ['snapshot', (v) => (SNAPSHOT_REF.test(v) ? v : null)],
];

function resultRefOf(raw: ResultRefInput): ActivityResultRef | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
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
  const id = optionalId.parse(payload.id);
  const kind = typeof payload.kind === 'string' ? payload.kind : '';
  const title = titleText.parse(payload.title);
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
    projectId: optionalId.parse(payload.projectId),
    threadId: optionalId.parse(payload.threadId),
    title,
    input,
    step: stepText.parse(payload.step),
    origin: isActivityOrigin(payload.origin) ? payload.origin : 'user',
    effects: parseActivityEffects(payload.effects),
    startedAt: new Date().toISOString(),
  };
  if (finalStatus) {
    row.status = finalStatus;
    row.error = finalStatus === 'failed' ? errorText.parse(payload.error) : null;
    row.resultRef = resultRefOf(resultRefInput.parse(payload.resultRef)) ?? null;
  }
  const { inserted, capped } = await repos.activities().insert(row);
  if (inserted) {
    const stored = await repos.activities().getById(id);
    if (stored) broadcastActivity(stored);
    broadcastActivitiesRemoved(ownerId, capped);
  }
  return { ok: true, applied: inserted };
}

/** The fields a runner may change on its own activity; never `origin`. */
function pickActivityPatch(value: RunnerFields): ActivityPatch {
  const patch: ActivityPatch = {};
  const status = reportedStatus.parse(value.status);
  if (status) patch.status = status;
  if ('step' in value) patch.step = stepText.parse(value.step);
  if ('error' in value) patch.error = errorText.parse(value.error);
  const resultRef = resultRefOf(resultRefInput.parse(value.resultRef));
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
  const id = optionalId.parse(args.id);
  if (!id) return { ok: false, error: 'activity id is invalid' };
  const patch = pickActivityPatch(runnerFieldsSchema.parse(args.patch));
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
  liveIds: string[],
): Promise<Activity[]> {
  const changed = await repos.activities().reconcile(runnerId, liveIds);
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
