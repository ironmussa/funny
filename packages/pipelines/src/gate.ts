/**
 * Concurrency groups: the `ConcurrencyGate` port and its in-memory default.
 *
 * A node with `concurrency: { group, limit }` asks the run's gate for a slot
 * before it executes, and holds it until its work has stopped. The gate is
 * shared by every run of a host, so the limit applies across runs: "one
 * merge at a time per repository". Hosts that run on several servers
 * implement the port with leases; the in-memory gate serves one process.
 *
 * **Batches.** A group may batch (`batch: { max, waitMs }`, with limit 1).
 * When its slot frees, the first waiter becomes the leader and the gate
 * hands it up to `max - 1` other waiters, waiting up to `waitMs` for more to
 * arrive. The leader's node runs once and settles each member through
 * `Batch.settle`: a member's acquire then resolves with that outcome instead
 * of a slot, and its node does not execute. A member settled `requeued`
 * goes back to the waiters in the place it had. A member whose request is
 * aborted leaves the batch (the leader sees it `cancelled`). When the leader
 * releases its slot, members it did not settle go back to waiting.
 */

/** A request for one slot of a group. */
export interface SlotRequest {
  /** The group, already computed from the run's inputs. */
  group: string;
  /** The limit the node declares; the host may replace it. */
  limit: number;
  /** Who asks: `<runId>/<nodeId>/<visit>`. */
  holder: string;
  /** Aborted when the node no longer wants the slot (run cancelled, sibling failed). */
  signal: AbortSignal;
  /** Called once if the request has to wait for a slot. */
  onWait: () => void;
  /** Set when the group batches: how many runs one execution may serve, and how long to gather them. */
  batch?: BatchPolicy;
  /** What a batch leader receives about this request as a member: the node's input. */
  input?: unknown;
}

/** How a group batches. */
export interface BatchPolicy {
  /** Most runs in one batch, the leader included. */
  max: number;
  /** How long the leader waits for more members before it starts. */
  waitMs: number;
}

/** Gives the slot back. Calling it more than once has no effect. */
export type SlotRelease = () => void;

/** The outcome a batch leader settles for a member. */
export type MemberOutcome =
  | { status: 'succeeded'; output?: unknown }
  | { status: 'failed'; error: string }
  /** The leader could not finish this member: it waits again in the place it had. */
  | { status: 'requeued' };

/** The outcomes that end a member's wait. */
export type SettledOutcome = Exclude<MemberOutcome, { status: 'requeued' }>;

/** Where a member of a batch stands. */
export type MemberState = 'pending' | 'succeeded' | 'failed' | 'requeued' | 'cancelled';

/** One member of a batch, as the leader sees it. */
export interface BatchMember {
  holder: string;
  /** The member's input to the node (`SlotRequest.input`). */
  input: unknown;
  readonly state: MemberState;
}

/** The batch a leader runs for. */
export interface Batch {
  /** The other runs of the batch; the leader is not among them. */
  readonly members: readonly BatchMember[];
  /** Settle one member. A member already settled or cancelled is left as it is. */
  settle(holder: string, outcome: MemberOutcome): void;
}

/** What an acquire resolves with. */
export type SlotGrant =
  /** Run the node; `batch` is set when this node leads a batch. */
  | { kind: 'slot'; release: SlotRelease; batch?: Batch }
  /** A leader ran the node for this request: complete with its outcome, without running. */
  | { kind: 'settled'; outcome: SettledOutcome };

/** The host port that grants concurrency-group slots. */
export interface ConcurrencyGate {
  /**
   * Resolve once a slot is granted, or once a batch leader settled this
   * request. Reject when `signal` aborts first; the request then leaves the
   * queue (or its batch).
   */
  acquire(request: SlotRequest): Promise<SlotGrant>;
}

/** Host hooks for the in-memory gate. */
export interface MemoryGateOptions {
  /** Replace the declared limit of a group (e.g. from host settings). */
  resolveLimit?: (group: string, declared: number) => number;
  /** Order waiters: lower first; equal priorities keep arrival order. Default 0. */
  priority?: (holder: string) => number;
}

interface Waiter {
  holder: string;
  limit: number;
  priority: number;
  seq: number;
  batch?: BatchPolicy;
  input: unknown;
  /** Where the request stands: queued, gathered by a forming batch, or a member of a running one. */
  place: 'queued' | 'forming' | 'member' | 'done';
  memberState: MemberState;
  resolve: (grant: SlotGrant) => void;
  reject: (error: Error) => void;
}

interface Forming {
  leader: Waiter;
  members: Waiter[];
  /** The slot the batch holds while it gathers members. */
  token: symbol;
  timer?: ReturnType<typeof setTimeout>;
}

interface Group {
  name: string;
  held: Set<symbol>;
  waiters: Waiter[];
  forming?: Forming;
}

const bySeat = (a: Waiter, b: Waiter) => a.priority - b.priority || a.seq - b.seq;

/** An in-memory gate for one process: waiters by priority, then arrival. */
export function createMemoryConcurrencyGate(options: MemoryGateOptions = {}): ConcurrencyGate {
  const groups = new Map<string, Group>();
  let seq = 0;

  const groupOf = (name: string): Group => {
    let g = groups.get(name);
    if (!g) {
      g = { name, held: new Set(), waiters: [] };
      groups.set(name, g);
    }
    return g;
  };

  const queue = (g: Group, w: Waiter) => {
    w.place = 'queued';
    g.waiters.push(w);
    g.waiters.sort(bySeat);
  };

  const unqueue = (g: Group, w: Waiter) => {
    const i = g.waiters.indexOf(w);
    if (i >= 0) g.waiters.splice(i, 1);
  };

  /** A slot for `w`: freed on release, which also returns unsettled members to the queue. */
  const grantSlot = (g: Group, w: Waiter, token: symbol, members?: Waiter[]) => {
    w.place = 'done';
    const release = () => {
      if (!g.held.delete(token)) return;
      for (const m of members ?? []) {
        if (m.place === 'member' && m.memberState === 'pending') queue(g, m);
      }
      pump(g);
    };
    w.resolve({ kind: 'slot', release, batch: members ? batchFor(g, members) : undefined });
  };

  const batchFor = (g: Group, members: Waiter[]): Batch => ({
    members: members.map((m) => ({
      holder: m.holder,
      input: m.input,
      get state() {
        return m.memberState;
      },
    })),
    settle(holder, outcome) {
      const m = members.find((x) => x.holder === holder);
      if (!m || m.place !== 'member' || m.memberState !== 'pending') return;
      m.memberState = outcome.status;
      if (outcome.status === 'requeued') {
        queue(g, m);
        pump(g);
        return;
      }
      m.place = 'done';
      m.resolve({ kind: 'settled', outcome });
    },
  });

  /** Gather queued batch waiters into the forming batch, up to its size. */
  const gather = (g: Group, f: Forming) => {
    const room = (f.leader.batch?.max ?? 1) - 1 - f.members.length;
    const taken = g.waiters.filter((w) => w.batch).slice(0, Math.max(0, room));
    for (const w of taken) {
      unqueue(g, w);
      w.place = 'forming';
      f.members.push(w);
    }
    if (f.members.length >= (f.leader.batch?.max ?? 1) - 1) start(g, f);
  };

  /** The batch starts: the leader gets the slot, the members wait for their outcome. */
  const start = (g: Group, f: Forming) => {
    if (g.forming !== f) return;
    clearTimeout(f.timer);
    g.forming = undefined;
    for (const m of f.members) {
      m.place = 'member';
      m.memberState = 'pending';
    }
    grantSlot(g, f.leader, f.token, f.members);
  };

  /** Grant slots to the first waiters while the group has room. */
  const pump = (g: Group) => {
    while (!g.forming && g.waiters.length > 0 && g.held.size < g.waiters[0].limit) {
      const w = g.waiters.shift()!;
      const token = Symbol(w.holder);
      g.held.add(token);
      if (!w.batch) {
        grantSlot(g, w, token);
        continue;
      }
      const f: Forming = { leader: w, members: [], token };
      w.place = 'forming';
      g.forming = f;
      gather(g, f);
      if (g.forming === f) {
        if (w.batch.waitMs <= 0) start(g, f);
        else f.timer = setTimeout(() => start(g, f), w.batch.waitMs);
      }
    }
    if (g.held.size === 0 && g.waiters.length === 0 && !g.forming) groups.delete(g.name);
  };

  /** `w`'s request was aborted: take it out of wherever it is. */
  const leave = (g: Group, w: Waiter) => {
    const f = g.forming;
    if (w.place === 'queued') unqueue(g, w);
    else if (w.place === 'member') w.memberState = 'cancelled';
    else if (f && w.place === 'forming' && f.leader === w) {
      // The leader left before the batch started: its gathered members wait again.
      clearTimeout(f.timer);
      g.forming = undefined;
      g.held.delete(f.token);
      for (const m of f.members) queue(g, m);
    } else if (f && w.place === 'forming') {
      f.members.splice(f.members.indexOf(w), 1);
    } else {
      return;
    }
    w.place = 'done';
    w.reject(abortError());
    pump(g);
  };

  return {
    acquire({ group, limit, holder, signal, onWait, batch, input }) {
      if (signal.aborted) return Promise.reject(abortError());
      const resolved = Math.max(1, Math.floor(options.resolveLimit?.(group, limit) ?? limit));
      return new Promise<SlotGrant>((resolve, reject) => {
        const g = groupOf(group);
        const waiter: Waiter = {
          holder,
          limit: resolved,
          priority: options.priority?.(holder) ?? 0,
          seq: seq++,
          batch: batch && batch.max > 1 ? batch : undefined,
          input,
          place: 'queued',
          memberState: 'pending',
          resolve: (grant) => {
            signal.removeEventListener('abort', onAbort);
            resolve(grant);
          },
          reject,
        };
        const onAbort = () => leave(g, waiter);
        signal.addEventListener('abort', onAbort, { once: true });
        queue(g, waiter);
        if (g.forming && waiter.batch) gather(g, g.forming);
        else pump(g);
        if (waiter.place === 'queued' || waiter.place === 'forming') onWait();
      });
    },
  };
}

function abortError(): Error {
  const error = new Error('The slot request was cancelled');
  error.name = 'AbortError';
  return error;
}

/** The process-wide gate runs use when their host passes none. */
export const defaultConcurrencyGate: ConcurrencyGate = createMemoryConcurrencyGate();
