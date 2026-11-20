/**
 * @domain subdomain: Workflow Engine
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * The engine's `ConcurrencyGate` on the server database (change
 * workflow-dag-engine, D5): concurrency-group slots shared by every server
 * instance, as leases.
 *
 * - A request becomes a row in `workflow_concurrency_waiters`. It is granted
 *   when the group has fewer live leases than its limit and it is the first
 *   waiter by `priority` then `requested_at`; the grant inserts its lease in
 *   `workflow_concurrency_leases` and removes the waiter, in one step
 *   serialized per group (a transaction holding a Postgres advisory lock on
 *   the group; on SQLite, one server, an in-process lock).
 * - A held lease is renewed every `renewMs` (30 s) and expires `ttlMs` (2 min)
 *   after its last renewal, so a server that stops frees its slots. A waiting
 *   request is renewed the same way, and dropped when it expires.
 * - A holder that already has a live lease adopts it: a run resumed after a
 *   restart asks again for the slot of the node it was running.
 * - Waiters poll every `pollMs`; a release on this server wakes them at once.
 *
 * A node whose lease expired while it was still running is not stopped: its
 * release is then a no-op and the next holder may start (design, Risks). The
 * lease state machine is in docs/architecture/state-machines.md.
 */
import type { ConcurrencyGate, MemoryGateOptions, SlotGrant, SlotRequest } from '@funny/pipelines';
import { and, asc, eq, lt, sql, type SQL } from 'drizzle-orm';

import { db, dbDialect, withDatabaseTransaction } from '../../db/index.js';
import { workflowConcurrencyLeases, workflowConcurrencyWaiters } from '../../db/schema.js';

export interface LeaseGateOptions extends MemoryGateOptions {
  /** Epoch-ms clock. Default: `Date.now`. */
  now?: () => number;
  /** How often a waiting request looks again. Default: 1000. */
  pollMs?: number;
  /** How often a held lease (or a waiting request) is renewed. Default: 30 000. */
  renewMs?: number;
  /** How long a lease or request lives without renewal. Default: 120 000. */
  ttlMs?: number;
}

export interface LeaseGate extends ConcurrencyGate {
  /** Stop renewing every lease this gate holds (the server is shutting down). */
  stop(): void;
}

const leaseOf = (group: string, holder: string) =>
  and(eq(workflowConcurrencyLeases.groupKey, group), eq(workflowConcurrencyLeases.holder, holder));

const waiterOf = (group: string, holder: string) =>
  and(
    eq(workflowConcurrencyWaiters.groupKey, group),
    eq(workflowConcurrencyWaiters.holder, holder),
  );

function abortError(): Error {
  const error = new Error('The slot request was cancelled');
  error.name = 'AbortError';
  return error;
}

/** Wait `ms`, or less when `wake` fires or `signal` aborts. */
function pause(ms: number, signal: AbortSignal, wake: Set<() => void>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wake.delete(done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Hold a Postgres advisory lock on `group` until the transaction ends, so
 * grant attempts of every server instance for one group run one at a time.
 */
async function lockGroupAcrossServers(group: string): Promise<void> {
  // SAFETY: only called on the Postgres dialect, whose Drizzle database has `execute`.
  const pg = db as { execute?: (query: SQL) => Promise<unknown> };
  await pg.execute?.(sql`SELECT pg_advisory_xact_lock(hashtext(${group}))`);
}

export function createLeaseGate(options: LeaseGateOptions = {}): LeaseGate {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1_000;
  const renewMs = options.renewMs ?? 30_000;
  const ttlMs = options.ttlMs ?? 120_000;
  /** Per group: the tail of the in-process chain that serializes grant attempts. */
  const locks = new Map<string, Promise<unknown>>();
  /** Per group: the pauses of this server's waiters, woken by a local release. */
  const wakers = new Map<string, Set<() => void>>();
  const renewals = new Set<ReturnType<typeof setInterval>>();

  const wakersOf = (group: string) => {
    let set = wakers.get(group);
    if (!set) wakers.set(group, (set = new Set()));
    return set;
  };

  /** Run `work` alone for `group`: in-process first, then across servers on Postgres. */
  const serialized = <T>(group: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(group) ?? Promise.resolve();
    const run = previous.then(() =>
      withDatabaseTransaction(async () => {
        if (dbDialect === 'pg') await lockGroupAcrossServers(group);
        return work();
      }),
    );
    const tail = run.catch(() => undefined);
    locks.set(group, tail);
    void tail.then(() => {
      if (locks.get(group) === tail) locks.delete(group);
    });
    return run;
  };

  /** Take a slot for `holder` if the group has room and it is first in line. */
  const tryGrant = (group: string, holder: string, limit: number) =>
    serialized(group, async () => {
      const at = now();
      await db
        .delete(workflowConcurrencyLeases)
        .where(
          and(
            eq(workflowConcurrencyLeases.groupKey, group),
            lt(workflowConcurrencyLeases.expiresAt, at),
          ),
        );
      await db
        .delete(workflowConcurrencyWaiters)
        .where(
          and(
            eq(workflowConcurrencyWaiters.groupKey, group),
            lt(workflowConcurrencyWaiters.expiresAt, at),
          ),
        );
      const leases = await db
        .select({ holder: workflowConcurrencyLeases.holder })
        .from(workflowConcurrencyLeases)
        .where(eq(workflowConcurrencyLeases.groupKey, group));
      const adopt = leases.some((l) => l.holder === holder);
      const [first] = await db
        .select({ holder: workflowConcurrencyWaiters.holder })
        .from(workflowConcurrencyWaiters)
        .where(eq(workflowConcurrencyWaiters.groupKey, group))
        .orderBy(
          asc(workflowConcurrencyWaiters.priority),
          asc(workflowConcurrencyWaiters.requestedAt),
          asc(workflowConcurrencyWaiters.holder),
        )
        .limit(1);
      if (!adopt && (leases.length >= limit || first?.holder !== holder)) return false;
      const expiresAt = at + ttlMs;
      await db
        .insert(workflowConcurrencyLeases)
        .values({ groupKey: group, holder, expiresAt, acquiredAt: at })
        .onConflictDoUpdate({
          target: [workflowConcurrencyLeases.groupKey, workflowConcurrencyLeases.holder],
          set: { expiresAt },
        });
      await db.delete(workflowConcurrencyWaiters).where(waiterOf(group, holder));
      return true;
    });

  /** Queue `holder` (or refresh its place, if it is already queued). */
  const enqueue = async (group: string, holder: string, limit: number) => {
    const at = now();
    await db
      .insert(workflowConcurrencyWaiters)
      .values({
        groupKey: group,
        holder,
        slotLimit: limit,
        priority: options.priority?.(holder) ?? 0,
        requestedAt: at,
        expiresAt: at + ttlMs,
      })
      .onConflictDoUpdate({
        target: [workflowConcurrencyWaiters.groupKey, workflowConcurrencyWaiters.holder],
        set: { expiresAt: at + ttlMs, slotLimit: limit },
      });
  };

  const renewWaiter = (group: string, holder: string) =>
    db
      .update(workflowConcurrencyWaiters)
      .set({ expiresAt: now() + ttlMs })
      .where(waiterOf(group, holder));

  const leave = (group: string, holder: string) =>
    db.delete(workflowConcurrencyWaiters).where(waiterOf(group, holder));

  /** The granted slot: renewed until released, then deleted and local waiters woken. */
  const grantedSlot = (group: string, holder: string): SlotGrant => {
    const renewal = setInterval(() => {
      void db
        .update(workflowConcurrencyLeases)
        .set({ expiresAt: now() + ttlMs })
        .where(leaseOf(group, holder))
        .catch(() => undefined);
    }, renewMs);
    renewal.unref?.();
    renewals.add(renewal);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(renewal);
      renewals.delete(renewal);
      void db
        .delete(workflowConcurrencyLeases)
        .where(leaseOf(group, holder))
        .then(() => {
          for (const wake of [...wakersOf(group)]) wake();
        })
        .catch(() => undefined);
    };
    return { kind: 'slot', release };
  };

  const acquire = async (request: SlotRequest): Promise<SlotGrant> => {
    const { group, holder, signal, onWait } = request;
    if (signal.aborted) throw abortError();
    const limit = Math.max(
      1,
      Math.floor(options.resolveLimit?.(group, request.limit) ?? request.limit),
    );
    await enqueue(group, holder, limit);
    let renewedAt = now();
    let waited = false;
    try {
      while (!(await tryGrant(group, holder, limit))) {
        if (signal.aborted) throw abortError();
        if (!waited) {
          waited = true;
          onWait();
        }
        if (now() - renewedAt >= renewMs) {
          await renewWaiter(group, holder);
          renewedAt = now();
        }
        await pause(pollMs, signal, wakersOf(group));
        if (signal.aborted) throw abortError();
      }
    } catch (err) {
      await leave(group, holder).catch(() => undefined);
      throw err;
    }
    return grantedSlot(group, holder);
  };

  return {
    acquire,
    stop() {
      for (const renewal of renewals) clearInterval(renewal);
      renewals.clear();
    },
  };
}
