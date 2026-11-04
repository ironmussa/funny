import type { DomainError } from '@funny/shared/errors';
import { createTransaction } from '@tanstack/db';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import i18n from '@/i18n/config';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';

const log = createClientLogger('data-write');

/**
 * An optimistic write on an entity collection (`entities.ts`).
 *
 * `apply` runs inside a manual TanStack DB transaction kept `pending` while
 * `persist` runs, so the change is visible in the same tick and synced writes
 * keep landing meanwhile (a *persisting* transaction would hold them for the
 * whole collection; see `threads/actions.ts`). On success `confirm` writes
 * the server result as synced before the overlay is dropped, so the commit
 * never flickers back. On failure the overlay is rolled back to the latest
 * synced rows and a toast is shown.
 */
export interface OptimisticWrite<R> {
  /** Entity name for telemetry and logs (`projects`, `templates`, …). */
  entity: string;
  operation: string;
  /** `collection.update/insert/delete` calls, run inside the transaction. */
  apply: () => void;
  persist: () => ResultAsync<R, DomainError>;
  /** Synced writes for the confirmed result. */
  confirm: (result: R) => void;
  /** i18n key of the toast title shown when the write is rolled back. */
  failureMessageKey: string;
}

function notifyFailure(write: OptimisticWrite<unknown>, error: DomainError): void {
  metric(`data.${write.entity}.write_failed`, 1, {
    attributes: { operation: write.operation, type: error.type },
  });
  log.warn('write rolled back', {
    entity: write.entity,
    operation: write.operation,
    error: error.message,
  });
  clientComposition.platform.effects.emit({
    type: 'toast',
    level: 'error',
    message: i18n.t(write.failureMessageKey),
    description: error.friendlyMessage ?? i18n.t(`errors.generic.${error.type}`),
  });
}

async function run<R>(write: OptimisticWrite<R>): Promise<Result<R, DomainError>> {
  const tx = createTransaction({ autoCommit: false, mutationFn: async () => {} });
  tx.mutate(write.apply);
  let result: Result<R, DomainError>;
  try {
    result = await write.persist();
  } catch (error) {
    // A throwing persist must not leave the overlay pending forever.
    tx.rollback();
    throw error;
  }
  if (result.isErr()) {
    tx.rollback();
    notifyFailure(write as OptimisticWrite<unknown>, result.error);
    return err(result.error);
  }
  write.confirm(result.value);
  await tx.commit();
  return ok(result.value);
}

export function optimisticWrite<R>(write: OptimisticWrite<R>): ResultAsync<R, DomainError> {
  return new ResultAsync(run(write));
}
