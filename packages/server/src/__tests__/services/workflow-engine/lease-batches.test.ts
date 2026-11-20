/**
 * Batch groups on the lease gate: a leader runs a node once for members
 * waiting on any server, settles each once, and its members return to the
 * queue when it releases without settling them or its server stops.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  definePipeline,
  node,
  runPipeline,
  type NodeRunInfo,
  type SlotGrant,
} from '@funny/pipelines';
import { sql } from 'drizzle-orm';

import { createLeaseGate, type LeaseGate } from '../../../services/workflow-engine/lease-gate.js';
import { createTestDb } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let clock = 1_000_000;
const gates: LeaseGate[] = [];
/** Requests a test leaves waiting: aborted after it, so they stop polling the next test's database. */
const pending: AbortController[] = [];

function server(opts: Parameters<typeof createLeaseGate>[0] = {}) {
  const gate = createLeaseGate({ now: () => clock, pollMs: 5, ...opts });
  gates.push(gate);
  return gate;
}

beforeEach(async () => {
  clock = 1_000_000;
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
});

afterEach(async () => {
  for (const c of pending.splice(0)) c.abort();
  for (const g of gates.splice(0)) g.stop();
  await new Promise((r) => setTimeout(r, 10));
});

const policy = { max: 5, waitMs: 0 };

function ask(gate: LeaseGate, holder: string, batch = policy) {
  const controller = new AbortController();
  pending.push(controller);
  const grant = gate.acquire({
    group: 'merge-o/r',
    limit: 1,
    holder,
    signal: controller.signal,
    onWait: () => {},
    batch,
    input: { pr: holder },
  });
  return { grant, controller };
}

const settledWithin = async <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

const slot = (g: SlotGrant) => {
  if (g.kind !== 'slot') throw new Error(`expected a slot, got ${g.kind}`);
  return g;
};

/** Hold the slot so the others queue, then let them gather behind a new leader. */
async function queueBehindHolder(holders: string[]) {
  const blocker = slot(await ask(server(), 'blocker/merge/1', { max: 1, waitMs: 0 }).grant);
  const asks = holders.map((h) => ask(server(), h));
  await new Promise((r) => setTimeout(r, 20));
  blocker.release();
  return asks;
}

describe('lease gate batches', () => {
  test('three runs on two servers are merged as one batch, each with its own outcome', async () => {
    const order: string[] = [];
    // The batch window is real time here.
    const a = server({ now: Date.now });
    const b = server({ now: Date.now });
    const flow = definePipeline<{ pr: number; merged?: unknown }>({
      name: 'merge',
      nodes: [
        node(
          'merge',
          (ctx, _signal, info: NodeRunInfo) => {
            order.push(`ran ${ctx.pr}`);
            for (const m of info.batch?.members ?? []) {
              info.batch!.settle(m.holder, { status: 'succeeded', output: { by: ctx.pr } });
            }
            return { ...ctx, merged: { by: ctx.pr } };
          },
          {
            concurrency: {
              group: 'merge-o/r',
              limit: 1,
              batch: {
                max: 5,
                waitMs: 30,
                adopt: (input, output) => ({ ...input, merged: output }),
              },
            },
          },
        ),
      ],
    });
    const results = await Promise.all([
      runPipeline(flow, { pr: 12 }, { gate: a, runId: 'r12' }),
      runPipeline(flow, { pr: 13 }, { gate: b, runId: 'r13' }),
      runPipeline(flow, { pr: 14 }, { gate: b, runId: 'r14' }),
    ]);
    expect(order).toHaveLength(1);
    const leader = Number(order[0].slice(4));
    for (const r of results) {
      expect(r.outcome).toBe('completed');
      expect(r.ctx.merged).toEqual({ by: leader });
    }
    expect(testDb.db.all(sql`SELECT * FROM workflow_concurrency_waiters`)).toEqual([]);
    expect(testDb.db.all(sql`SELECT * FROM workflow_concurrency_leases`)).toEqual([]);
  });

  test('a member is settled once', async () => {
    const [lead, member] = await queueBehindHolder(['r12/merge/1', 'r13/merge/1']);
    const leader = slot(await lead.grant);
    const m = leader.batch!.members[0];
    leader.batch!.settle(m.holder, { status: 'failed', error: 'conflict' });
    leader.batch!.settle(m.holder, { status: 'succeeded' });
    expect(await member.grant).toEqual({
      kind: 'settled',
      outcome: { status: 'failed', error: 'conflict' },
    });
    expect(m.state).toBe('failed');
    leader.release();
  });

  test('a requeued member waits again in its place and leads the next batch', async () => {
    const [lead, member] = await queueBehindHolder(['r12/merge/1', 'r13/merge/1']);
    const leader = slot(await lead.grant);
    leader.batch!.settle(leader.batch!.members[0].holder, { status: 'requeued' });
    await new Promise((r) => setTimeout(r, 20));
    const late = ask(server(), 'r20/merge/1');
    await new Promise((r) => setTimeout(r, 20));
    leader.release();
    const next = slot(await member.grant);
    expect(next.batch!.members.map((x) => x.holder)).toEqual(['r20/merge/1']);
    next.release();
    await late.grant;
  });

  test('a member whose run is cancelled leaves the batch; the leader sees it cancelled', async () => {
    const [lead, member] = await queueBehindHolder(['r12/merge/1', 'r13/merge/1']);
    const leader = slot(await lead.grant);
    member.controller.abort();
    await expect(member.grant).rejects.toThrow(/cancelled/);
    const m = leader.batch!.members[0];
    leader.batch!.settle(m.holder, { status: 'succeeded' });
    await new Promise((r) => setTimeout(r, 20));
    expect(m.state).toBe('cancelled');
    leader.release();
  });

  test('members the leader releases without settling wait again', async () => {
    const [lead, member] = await queueBehindHolder(['r12/merge/1', 'r13/merge/1']);
    slot(await lead.grant).release();
    const next = slot(await member.grant);
    expect(next.batch!.members).toEqual([]);
    next.release();
  });

  test("when the leader's server stops, its lease expires and the members wait again", async () => {
    const blocker = slot(await ask(server(), 'blocker/merge/1', { max: 1, waitMs: 0 }).grant);
    // The leader's server never renews (it stops right after the batch starts).
    const lead = ask(server({ renewMs: 10_000_000 }), 'r12/merge/1');
    const member = ask(server(), 'r13/merge/1');
    await new Promise((r) => setTimeout(r, 20));
    blocker.release();
    const leader = slot(await lead.grant);
    expect(leader.batch!.members.map((m) => m.holder)).toEqual(['r13/merge/1']);
    expect(await settledWithin(member.grant, 40)).toBe(false);
    clock += 121_000;
    const taken = await member.grant;
    expect(slot(taken).batch!.members).toEqual([]);
  });
});
