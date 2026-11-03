import type { PermissionMode, Thread, ThreadStage } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { createTransaction } from '@tanstack/db';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import i18n from '@/i18n/config';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { removeThreadLocally } from './loaders';
import { getThreadsData } from './store';

const log = createClientLogger('data-threads');

/**
 * Optimistic thread writes.
 *
 * Each write is a manual TanStack DB transaction kept `pending` while the
 * API calls run, then committed with a no-op mutation function. We do not
 * use collection `onUpdate` handlers: while a transaction is *persisting*,
 * TanStack DB holds back every synced write to the whole collection. A slow
 * archive would then freeze realtime status updates for every other thread.
 * A pending transaction holds nothing: synced writes keep landing, and the
 * optimistic overlay stays on top of its own row until commit or rollback.
 *
 * On success each step's fields are confirmed as synced and fenced before
 * the overlay is dropped, so neither the commit nor a stale list response
 * can revert them (spec: *Optimistic writes never revert on stale data*).
 * On failure the overlay is rolled back to the latest synced row, which
 * keeps any realtime change that arrived meanwhile, and a toast is shown
 * (spec: *Failed writes roll back with feedback*).
 */

interface ThreadWriteStep {
  fields: Partial<Thread>;
  persist: () => ResultAsync<unknown, DomainError>;
}

function notifyFailure(threadId: string, operation: string, error: DomainError): void {
  metric('data.threads.write_failed', 1, { attributes: { operation, type: error.type } });
  log.warn('thread write rolled back', { threadId, operation, error: error.message });
  clientComposition.platform.effects.emit({
    type: 'toast',
    level: 'error',
    message: i18n.t('errors.threadUpdateFailed'),
    description: error.friendlyMessage ?? i18n.t(`errors.generic.${error.type}`),
  });
}

async function runWrite(
  threadId: string,
  operation: string,
  steps: readonly ThreadWriteStep[],
  layer: DataLayer,
): Promise<Result<void, DomainError>> {
  const data = getThreadsData(layer);
  const fields = Object.assign({}, ...steps.map((s) => s.fields)) as Partial<Thread>;

  const tx = data.collection.has(threadId)
    ? createTransaction<Thread>({ autoCommit: false, mutationFn: async () => {} })
    : null;
  tx?.mutate(() => {
    data.collection.update(threadId, (draft) => {
      Object.assign(draft, fields);
    });
  });

  for (const step of steps) {
    const result = await step.persist();
    if (result.isErr()) {
      tx?.rollback();
      notifyFailure(threadId, operation, result.error);
      return err(result.error);
    }
    data.confirmWrite(threadId, step.fields);
  }
  await tx?.commit();
  return ok(undefined);
}

function write(
  threadId: string,
  operation: string,
  steps: readonly ThreadWriteStep[],
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return new ResultAsync(runWrite(threadId, operation, steps, layer));
}

export function archiveThread(threadId: string, layer?: DataLayer) {
  return write(
    threadId,
    'archive',
    [{ fields: { archived: true }, persist: () => api.archiveThread(threadId, true) }],
    layer,
  );
}

/** Unarchive into `stage`. Two server calls; a failed second call keeps the first. */
export function unarchiveThread(threadId: string, stage: ThreadStage, layer?: DataLayer) {
  return write(
    threadId,
    'unarchive',
    [
      { fields: { archived: false }, persist: () => api.archiveThread(threadId, false) },
      { fields: { stage }, persist: () => api.updateThreadStage(threadId, stage) },
    ],
    layer,
  );
}

export function moveThreadStage(threadId: string, stage: ThreadStage, layer?: DataLayer) {
  return write(
    threadId,
    'stage',
    [{ fields: { stage }, persist: () => api.updateThreadStage(threadId, stage) }],
    layer,
  );
}

export function renameThread(threadId: string, title: string, layer?: DataLayer) {
  return write(
    threadId,
    'rename',
    [{ fields: { title }, persist: () => api.renameThread(threadId, title) }],
    layer,
  );
}

export function pinThread(threadId: string, pinned: boolean, layer?: DataLayer) {
  return write(
    threadId,
    'pin',
    [{ fields: { pinned }, persist: () => api.pinThread(threadId, pinned) }],
    layer,
  );
}

export function setThreadPermissionMode(
  threadId: string,
  permissionMode: PermissionMode,
  layer?: DataLayer,
) {
  return write(
    threadId,
    'permission-mode',
    [
      {
        fields: { permissionMode },
        persist: () => api.updateThreadPermissionMode(threadId, permissionMode),
      },
    ],
    layer,
  );
}

/**
 * Delete a thread optimistically: it leaves every list in the same tick and
 * comes back (with a toast) if the server refuses. A running agent is
 * stopped first; as before, a failed stop does not block the delete.
 */
export function deleteThread(
  threadId: string,
  options: { stopFirst?: boolean } = {},
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return new ResultAsync(runDelete(threadId, options.stopFirst ?? false, layer));
}

async function runDelete(
  threadId: string,
  stopFirst: boolean,
  layer: DataLayer,
): Promise<Result<void, DomainError>> {
  const data = getThreadsData(layer);
  const tx = data.collection.has(threadId)
    ? createTransaction<Thread>({ autoCommit: false, mutationFn: async () => {} })
    : null;
  tx?.mutate(() => {
    data.collection.delete(threadId);
  });

  if (stopFirst) await api.stopThread(threadId);
  const result = await api.deleteThread(threadId);
  if (result.isErr()) {
    tx?.rollback();
    notifyFailure(threadId, 'delete', result.error);
    return err(result.error);
  }
  removeThreadLocally(threadId, layer);
  await tx?.commit();
  return ok(undefined);
}
