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
 * - Batches (D5b): a leader of a batching group gathers up to `max - 1` free
 *   batch waiters (marking them with its holder), and more that arrive within
 *   `waitMs`. A member does not compete for the slot: it waits for the outcome
 *   its leader settles (a compare-and-set, so once), then leaves the queue. A
 *   member settled `requeued`, or not settled when the leader releases, waits
 *   again in its place; so do the members of a leader whose lease expired.
 *
 * A node whose lease expired while it was still running is not stopped: its
 * release is then a no-op and the next holder may start (design, Risks). The
 * lease state machine is in docs/architecture/state-machines.md.
 */
import type {
  Batch,
  BatchMember,
  BatchPolicy,
  ConcurrencyGate,
  MemberOutcome,
  MemberState,
  MemoryGateOptions,
  SlotGrant,
  SlotRequest,
} from '@funny/pipelines';
import { sql, type SQL } from 'drizzle-orm';

import { db, dbDialect, withDatabaseTransaction } from '../../db/index.js';
import {
  deleteLease,
  dropExpired,
  enqueueWaiter,
  firstFreeWaiter,
  freeOrphanedMembers,
  gatherMembers,
  leaseHolders,
  putLease,
  readWaiter,
  releaseMembers,
  removeWaiter,
  renewLease,
  renewWaiter,
  settleMember,
  type GatheredMember,
} from './lease-store.js';

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

/** What node-postgres answers a raw query with; the lock's rows are not read. */
interface RawQueryResult {
  rows: object[];
}

/**
 * Hold a Postgres advisory lock on `group` until the transaction ends, so
 * grant attempts of every server instance for one group run one at a time.
 */
async function lockGroupAcrossServers(group: string): Promise<void> {
  // SAFETY: only called on the Postgres dialect, whose Drizzle database has `execute`.
  const pg = db as { execute?: (query: SQL) => Promise<RawQueryResult> };
  await pg.execute?.(sql`SELECT pg_advisory_xact_lock(hashtext(${group}))`);
}

/** One request's way through the gate. */
interface Ask {
  group: string;
  holder: string;
  limit: number;
  signal: AbortSignal;
  onWait: () => void;
  batch?: BatchPolicy;
  /** Put the request (back) in the queue. */
  enqueue: () => Promise<void>;
}

export function createLeaseGate(options: LeaseGateOptions = {}): LeaseGate {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1_000;
  const renewMs = options.renewMs ?? 30_000;
  const ttlMs = options.ttlMs ?? 120_000;
  /** Per group: the tail of the in-process chain that serializes grant attempts. */
  const locks = new Map<string, Promise<unknown>>();
  /** Per group: the pauses of this server's waiters, woken by a local change. */
  const wakers = new Map<string, Set<() => void>>();
  const renewals = new Set<ReturnType<typeof setInterval>>();

  const wakersOf = (group: string) => {
    let set = wakers.get(group);
    if (!set) wakers.set(group, (set = new Set()));
    return set;
  };
  const wakeGroup = (group: string) => {
    for (const wake of [...wakersOf(group)]) wake();
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

  /** Drop expired rows and free the members of leaders without a lease; the live lease holders. */
  const tidy = async (group: string) => {
    await dropExpired(group, now());
    const holders = await leaseHolders(group);
    await freeOrphanedMembers(group, holders);
    return holders;
  };

  /** Take a slot for `holder` if the group has room and it is first in line (or holds it already). */
  const tryGrant = (group: string, holder: string, limit: number) =>
    serialized(group, async () => {
      const at = now();
      const holders = await tidy(group);
      const adopt = holders.includes(holder);
      if (!adopt && (holders.length >= limit || (await firstFreeWaiter(group)) !== holder)) {
        return false;
      }
      await putLease(group, holder, at, at + ttlMs);
      await removeWaiter(group, holder);
      return true;
    });

  /**
   * Wait until the request is granted a slot (true), or until a batch leader
   * settled it (the outcome). Renews the request while it waits.
   */
  const waitForTurn = async (ask: Ask): Promise<true | SlotGrant> => {
    let renewedAt = now();
    let waited = false;
    for (;;) {
      const mine = await readWaiter(ask.group, ask.holder);
      if (!mine) {
        // Our request expired (we could not renew it in time): queue it again.
        await ask.enqueue();
        renewedAt = now();
        continue;
      }
      if (mine.outcome) {
        await removeWaiter(ask.group, ask.holder);
        return { kind: 'settled', outcome: mine.outcome };
      }
      if (mine.leader) {
        // In a batch: wait for the outcome, but notice a leader whose server stopped.
        await serialized(ask.group, () => tidy(ask.group));
      } else if (await tryGrant(ask.group, ask.holder, ask.limit)) {
        return true;
      }
      if (!waited) {
        waited = true;
        ask.onWait();
      }
      if (now() - renewedAt >= renewMs) {
        await renewWaiter(ask.group, ask.holder, now() + ttlMs);
        renewedAt = now();
      }
      await pause(pollMs, ask.signal, wakersOf(ask.group));
      if (ask.signal.aborted) throw abortError();
    }
  };

  /** Renew `holder`'s lease until `stopRenewing` is called. */
  const keepRenewed = (group: string, holder: string) => {
    const renewal = setInterval(() => {
      void renewLease(group, holder, now() + ttlMs).catch(() => undefined);
    }, renewMs);
    renewal.unref?.();
    renewals.add(renewal);
    return () => {
      clearInterval(renewal);
      renewals.delete(renewal);
    };
  };

  /** Gather the leader's members: at once, then as they arrive, until full or `waitMs` ends. */
  const gather = async (ask: Ask, policy: BatchPolicy): Promise<GatheredMember[]> => {
    const room = policy.max - 1;
    const until = now() + policy.waitMs;
    for (;;) {
      const members = await serialized(ask.group, () => gatherMembers(ask.group, ask.holder, room));
      if (members.length >= room || now() >= until) return members;
      await pause(pollMs, ask.signal, wakersOf(ask.group));
      if (ask.signal.aborted) throw abortError();
    }
  };

  /** The leader's view of its batch: settle writes are queued, so release can wait for them. */
  const batchFor = (ask: Ask, gathered: GatheredMember[]) => {
    const states = new Map<string, MemberState>(gathered.map((m) => [m.holder, 'pending']));
    let writes: Promise<unknown> = Promise.resolve();
    const members: BatchMember[] = gathered.map((m) => ({
      holder: m.holder,
      input: m.input,
      get state() {
        return states.get(m.holder) ?? 'cancelled';
      },
    }));
    const settle = (holder: string, outcome: MemberOutcome) => {
      if (states.get(holder) !== 'pending') return;
      states.set(holder, outcome.status);
      writes = writes
        .then(() => settleMember(ask.group, ask.holder, holder, outcome))
        .then((settled) => {
          if (!settled) states.set(holder, 'cancelled');
          wakeGroup(ask.group);
        })
        .catch(() => undefined);
    };
    const batch: Batch = { members, settle };
    return { batch, flushed: () => writes };
  };

  /** The granted slot: renewed until released; a batch leader's release frees its unsettled members. */
  const grantedSlot = (
    ask: Ask,
    stopRenewing: () => void,
    led?: ReturnType<typeof batchFor>,
  ): SlotGrant => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      stopRenewing();
      void (led?.flushed() ?? Promise.resolve())
        .then(() => (led ? releaseMembers(ask.group, ask.holder) : undefined))
        .then(() => deleteLease(ask.group, ask.holder))
        .then(() => wakeGroup(ask.group))
        .catch(() => undefined);
    };
    return { kind: 'slot', release, batch: led?.batch };
  };

  /** The request as the gate handles it: its limit (the host may replace it) and batch policy. */
  const askFor = (request: SlotRequest): Ask => {
    const { group, holder, signal, onWait, input } = request;
    const declared = options.resolveLimit?.(group, request.limit) ?? request.limit;
    const limit = Math.max(1, Math.floor(declared));
    const batch = request.batch && request.batch.max > 1 ? request.batch : undefined;
    const enqueue = () => {
      const at = now();
      const priority = options.priority?.(holder) ?? 0;
      const expiresAt = at + ttlMs;
      return enqueueWaiter({ group, holder, limit, priority, at, expiresAt, batch, input });
    };
    return { group, holder, limit, signal, onWait, batch, enqueue };
  };

  /** Lead a batch from the granted slot; if the leader leaves while gathering, give everything back. */
  const lead = async (ask: Ask, policy: BatchPolicy, stopRenewing: () => void) => {
    try {
      return grantedSlot(ask, stopRenewing, batchFor(ask, await gather(ask, policy)));
    } catch (err) {
      stopRenewing();
      await releaseMembers(ask.group, ask.holder).catch(() => undefined);
      await deleteLease(ask.group, ask.holder).catch(() => undefined);
      wakeGroup(ask.group);
      throw err;
    }
  };

  const acquire = async (request: SlotRequest): Promise<SlotGrant> => {
    if (request.signal.aborted) throw abortError();
    const ask = askFor(request);
    await ask.enqueue();
    let turn: true | SlotGrant;
    try {
      turn = await waitForTurn(ask);
    } catch (err) {
      await removeWaiter(ask.group, ask.holder).catch(() => undefined);
      throw err;
    }
    if (turn !== true) return turn;
    const stopRenewing = keepRenewed(ask.group, ask.holder);
    return ask.batch ? lead(ask, ask.batch, stopRenewing) : grantedSlot(ask, stopRenewing);
  };

  return {
    acquire,
    stop() {
      for (const renewal of renewals) clearInterval(renewal);
      renewals.clear();
    },
  };
}
