/**
 * Concurrency-group leases on the server database: two gates on one
 * database stand for two server instances.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { definePipeline, node, runPipeline, type SlotGrant } from '@funny/pipelines';
import { sql } from 'drizzle-orm';

import { createLeaseGate, type LeaseGate } from '../../../services/workflow-engine/lease-gate.js';
import { createTestDb } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let clock = 1_000_000;
const gates: LeaseGate[] = [];
/** Requests a test leaves waiting: aborted after it, so they stop polling the next test's database. */
const pending: AbortController[] = [];

/** A gate as another server would have: same database, its own timers. */
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

const ask = (gate: LeaseGate, holder: string, opts: { limit?: number; group?: string } = {}) => {
  const controller = new AbortController();
  pending.push(controller);
  let waited = false;
  const grant = gate.acquire({
    group: opts.group ?? 'merge-o/r',
    limit: opts.limit ?? 1,
    holder,
    signal: controller.signal,
    onWait: () => (waited = true),
  });
  return { grant, controller, waited: () => waited };
};

const release = (grant: SlotGrant) => {
  if (grant.kind === 'slot') grant.release();
};

const settledWithin = async <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

const leases = () =>
  testDb.db.all<{ holder: string }>(
    sql`SELECT holder FROM workflow_concurrency_leases ORDER BY holder`,
  );

describe('lease gate', () => {
  test('two servers competing: one holds the slot, the other waits and gets it on release', async () => {
    const a = server();
    const b = server();
    const first = ask(a, 'r12/merge/1');
    const firstGrant = await first.grant;
    const second = ask(b, 'r13/merge/1');
    expect(await settledWithin(second.grant, 40)).toBe(false);
    expect(second.waited()).toBe(true);
    expect(first.waited()).toBe(false);
    expect(leases()).toEqual([{ holder: 'r12/merge/1' }]);

    release(firstGrant);
    expect(await settledWithin(second.grant, 200)).toBe(true);
    expect(leases()).toEqual([{ holder: 'r13/merge/1' }]);
  });

  test('different groups do not wait for each other', async () => {
    const a = server();
    await ask(a, 'r1/merge/1', { group: 'merge-a' }).grant;
    expect(await settledWithin(ask(server(), 'r2/merge/1', { group: 'merge-b' }).grant, 100)).toBe(
      true,
    );
  });

  test('a lease whose server stopped renewing it expires, and a waiter takes the slot', async () => {
    // Server A takes the slot and then "crashes": it never renews nor releases.
    const a = server({ renewMs: 10_000_000 });
    await ask(a, 'r12/merge/1').grant;
    const b = server();
    const waiting = ask(b, 'r13/merge/1');
    expect(await settledWithin(waiting.grant, 40)).toBe(false);
    clock += 119_000;
    expect(await settledWithin(waiting.grant, 40)).toBe(false);
    clock += 2_000;
    expect(await settledWithin(waiting.grant, 200)).toBe(true);
  });

  test('a held lease is renewed, so it outlives its first expiry', async () => {
    const a = server({ renewMs: 5 });
    await ask(a, 'r12/merge/1').grant;
    clock += 100_000;
    await new Promise((r) => setTimeout(r, 30));
    clock += 100_000;
    const waiting = ask(server(), 'r13/merge/1');
    expect(await settledWithin(waiting.grant, 60)).toBe(false);
  });

  test('waiters are served by priority, then arrival', async () => {
    const priority = (holder: string) => (holder.startsWith('urgent') ? 0 : 1);
    const a = server({ priority });
    const holding = await ask(a, 'first/merge/1').grant;
    const order: string[] = [];
    const queue = ['late-1/merge/1', 'late-2/merge/1', 'urgent/merge/1'].map((holder) => {
      const req = ask(server({ priority }), holder);
      void req.grant.then((g) => {
        order.push(holder);
        setTimeout(() => release(g), 5);
      });
      return req.grant;
    });
    await new Promise((r) => setTimeout(r, 30));
    release(holding);
    await Promise.all(queue);
    expect(order).toEqual(['urgent/merge/1', 'late-1/merge/1', 'late-2/merge/1']);
  });

  test('a request cancelled while waiting leaves the queue', async () => {
    const a = server();
    const holding = await ask(a, 'r1/merge/1').grant;
    const waiting = ask(server(), 'r2/merge/1');
    await new Promise((r) => setTimeout(r, 20));
    waiting.controller.abort();
    await expect(waiting.grant).rejects.toThrow(/cancelled/);
    expect(testDb.db.all(sql`SELECT * FROM workflow_concurrency_waiters`)).toEqual([]);
    release(holding);
  });

  test('a resumed holder adopts the live lease it already had', async () => {
    await ask(server({ renewMs: 10_000_000 }), 'r12/merge/1').grant;
    // The server restarted; the resumed run asks again for the same slot.
    expect(await settledWithin(ask(server(), 'r12/merge/1').grant, 100)).toBe(true);
    expect(leases()).toEqual([{ holder: 'r12/merge/1' }]);
  });

  test('two runs of one repository merge one after the other through the engine', async () => {
    const order: string[] = [];
    const flow = definePipeline<{ run: string }>({
      name: 'merge',
      nodes: [
        node(
          'merge',
          async (ctx) => {
            order.push(`start ${ctx.run}`);
            await new Promise((r) => setTimeout(r, 20));
            order.push(`end ${ctx.run}`);
            return ctx;
          },
          { concurrency: { group: 'merge-o/r', limit: 1 } },
        ),
      ],
    });
    await Promise.all([
      runPipeline(flow, { run: 'a' }, { gate: server(), runId: 'a' }),
      runPipeline(flow, { run: 'b' }, { gate: server(), runId: 'b' }),
    ]);
    expect(order[1]).toBe(`end ${order[0].slice(6)}`);
    expect(leases()).toEqual([]);
  });
});
