/**
 * Log-only check of thread status writes against the thread machine
 * (docs/architecture/state-machines.md, "Thread status, around the machine").
 *
 * About thirty writers store a thread status directly. Before they are made to
 * go through the machine, this records which transitions they actually make
 * that the machine does not model, so the missing transitions can be added
 * first and enforcing then breaks nothing. Nothing is blocked here.
 *
 * Every such write counts `thread.status_write_unmodelled` (attributes `from`,
 * `to`); the first one of each pair per process is also logged.
 */

import { isThreadStatus, isThreadStatusWriteModelled } from '@funny/shared/thread-machine';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

const loggedPairs = new Set<string>();

/** Whether the write is one the machine models; reports it when it is not. */
export function observeThreadStatusWrite(write: {
  threadId: string;
  from: string | null;
  to: string;
}): boolean {
  // No row yet (an insert-like first write) has no transition to check.
  if (write.from === null) return true;
  const { from, to } = write;
  const known = isThreadStatus(from) && isThreadStatus(to);
  if (known && isThreadStatusWriteModelled(from, to)) return true;
  metric('thread.status_write_unmodelled', 1, {
    attributes: { from: write.from, to: write.to },
  });
  const pair = `${write.from}->${write.to}`;
  if (!loggedPairs.has(pair)) {
    loggedPairs.add(pair);
    log.warn('Thread status write the thread machine does not model', {
      namespace: 'thread-status',
      threadId: write.threadId,
      from: write.from,
      to: write.to,
      known,
    });
  }
  return false;
}
