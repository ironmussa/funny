/**
 * Stops sandboxes nobody is using (change thread-sandboxes), so a thread only
 * costs money while it works. A sandbox is idle when its thread is not active
 * (no pending/running/waiting agent) and neither the thread nor the sandbox
 * changed for the idle window. Wake-on-demand brings it back on the next use.
 */

import { eq } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { ThreadSandboxControl } from './thread-sandbox-control.js';

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60_000;
const ACTIVE_THREAD_STATUSES = new Set(['pending', 'running', 'waiting']);

export interface IdleCandidate {
  threadId: string;
  threadStatus: string | null;
  /** ISO timestamps; the most recent one counts as the last activity. */
  threadUpdatedAt: string | null;
  sandboxUpdatedAt: string;
}

/** Running sandboxes with their thread's status and last change. */
function listRunningSandboxes(): ResultAsync<IdleCandidate[], string> {
  return ResultAsync.fromPromise(
    db
      .select({
        threadId: threadSandboxes.threadId,
        threadStatus: threads.status,
        threadUpdatedAt: threads.updatedAt,
        sandboxUpdatedAt: threadSandboxes.updatedAt,
      })
      .from(threadSandboxes)
      .leftJoin(threads, eq(threads.id, threadSandboxes.threadId))
      .where(eq(threadSandboxes.state, 'running')),
    (error) => (error instanceof Error ? error.message : String(error)),
  );
}

export function isIdle(candidate: IdleCandidate, nowMs: number, idleMs: number): boolean {
  if (candidate.threadStatus && ACTIVE_THREAD_STATUSES.has(candidate.threadStatus)) return false;
  const lastActivity = Math.max(
    Date.parse(candidate.sandboxUpdatedAt) || 0,
    Date.parse(candidate.threadUpdatedAt ?? '') || 0,
  );
  return nowMs - lastActivity >= idleMs;
}

export function createSandboxIdleSweeper(deps: {
  control: Pick<ThreadSandboxControl, 'stop'>;
  listRunning?: () => ResultAsync<IdleCandidate[], string>;
  idleMs?: number;
  now?: () => number;
}) {
  const idleMs = deps.idleMs ?? DEFAULT_SANDBOX_IDLE_MS;
  const listRunning = deps.listRunning ?? listRunningSandboxes;
  const now = deps.now ?? Date.now;

  return {
    /** One pass: stop every idle sandbox. Returns the threads whose sandbox stopped. */
    async sweep(): Promise<string[]> {
      const running = await listRunning();
      if (running.isErr()) {
        log.warn('Sandbox idle sweep could not list sandboxes', {
          namespace: 'thread-sandboxes',
          error: running.error,
        });
        return [];
      }
      const stopped: string[] = [];
      for (const candidate of running.value.filter((c) => isIdle(c, now(), idleMs))) {
        const result = await deps.control.stop(candidate.threadId);
        if (result.isOk()) {
          stopped.push(candidate.threadId);
          metric('thread_sandboxes.idle_stopped', 1, { attributes: { state: result.value } });
        } else {
          log.warn('Failed to stop idle sandbox', {
            namespace: 'thread-sandboxes',
            threadId: candidate.threadId,
            error: result.error.message,
          });
        }
      }
      return stopped;
    },
  };
}
