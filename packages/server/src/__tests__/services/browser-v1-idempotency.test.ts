import { describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';
import { StatusCode } from '@funny/shared/browser-v1/common';
import { OperationOutcomeSchema } from '@funny/shared/browser-v1/operations';

import type { SqlOperationIdempotencyStore } from '../../services/operation-idempotency.js';
import {
  BrowserV1IdempotencyStore,
  DurableBrowserV1IdempotencyStore,
} from '../../services/socketio/browser-v1-idempotency.js';

function outcome(requestId = 'request-1') {
  return create(OperationOutcomeSchema, {
    requestId,
    outcome: { case: 'status', value: { code: StatusCode.CONFLICT, message: 'stored' } },
  });
}

describe('browser.v1 idempotency', () => {
  test('deduplicates concurrent compatible work and rejects key conflicts', async () => {
    const store = new BrowserV1IdempotencyStore({ retentionMs: 1_000, maxEntries: 10 });
    let executions = 0;
    const input = {
      principalUserId: 'user-1',
      idempotencyKey: 'key-1',
      fingerprint: 'fingerprint-1',
      operation: async () => {
        executions += 1;
        return outcome();
      },
    };
    const [first, replay] = await Promise.all([store.execute(input), store.execute(input)]);
    expect(executions).toBe(1);
    expect(first).toMatchObject({ kind: 'outcome', replayed: false });
    expect(replay).toMatchObject({ kind: 'outcome', replayed: true });
    expect(
      await store.execute({ ...input, fingerprint: 'different', operation: async () => outcome() }),
    ).toEqual({ kind: 'conflict' });
  });

  test('serializes durable outcomes for replay after a lost acknowledgement', async () => {
    let storedOutcome = '';
    let calls = 0;
    const sql = {
      execute: async (_input: unknown, execute: () => Promise<string>) => {
        calls += 1;
        if (!storedOutcome) {
          storedOutcome = await execute();
          return { kind: 'executed' as const, outcome: storedOutcome };
        }
        return { kind: 'replayed' as const, outcome: storedOutcome };
      },
    };
    const store = new DurableBrowserV1IdempotencyStore(
      sql as unknown as SqlOperationIdempotencyStore,
    );
    let executions = 0;
    const input = {
      principalUserId: 'user-1',
      idempotencyKey: 'durable-key',
      fingerprint: 'same-request',
      operation: async () => {
        executions += 1;
        return outcome('durable-request');
      },
    };
    const first = await store.execute(input);
    const replay = await store.execute(input);
    expect(calls).toBe(2);
    expect(executions).toBe(1);
    expect(first).toMatchObject({ kind: 'outcome', replayed: false });
    expect(replay).toMatchObject({ kind: 'outcome', replayed: true });
    if (replay.kind === 'outcome') expect(replay.outcome).toEqual(outcome('durable-request'));
  });
});
