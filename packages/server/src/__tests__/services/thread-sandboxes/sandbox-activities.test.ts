/**
 * Sandbox actions funny takes on its own are recorded (track-funny-actions,
 * design D7): stop and wake only when they fail, destroy every time, for the
 * sandbox row's owner.
 */
import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import type {
  ServerActivityOutcome,
  ServerActivitySpec,
} from '../../../services/activities/server-activities.js';
import { recordingSandboxControl } from '../../../services/thread-sandboxes/sandbox-activities.js';

function setup(row: { userId: string } | null = { userId: 'alice' }) {
  const recorded: Array<{ spec: ServerActivitySpec; outcome: ServerActivityOutcome }> = [];
  const context = {
    destroyReason: 'idle' as const,
    origin: 'system' as const,
    store: { get: () => okAsync(row as never) },
    activities: {
      recordServerActivity: async (spec: ServerActivitySpec, outcome: ServerActivityOutcome) => {
        recorded.push({ spec, outcome });
      },
    },
  };
  return { recorded, context };
}

const failure = { kind: 'sandbox' as const, message: 'provider refused' };

describe('recordingSandboxControl', () => {
  test('an idle stop that succeeds passes the on-failure kind through', async () => {
    const { recorded, context } = setup();
    const control = recordingSandboxControl(
      { stop: (_threadId: string) => okAsync('stopped' as const) },
      context,
    );
    expect((await control.stop!('t1'))._unsafeUnwrap()).toBe('stopped');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.spec).toMatchObject({
      kind: 'sandbox.stop',
      userId: 'alice',
      origin: 'system',
    });
    expect(recorded[0]!.outcome.ok).toBe(true);
  });

  test('an idle stop that destroys an ephemeral machine records a destroy', async () => {
    const { recorded, context } = setup();
    const control = recordingSandboxControl(
      { stop: (_threadId: string) => okAsync('lost' as const) },
      context,
    );
    await control.stop!('t1');
    expect(recorded[0]!.spec).toMatchObject({ kind: 'sandbox.destroy', input: { reason: 'idle' } });
  });

  test('a failed wake is recorded with its error', async () => {
    const { recorded, context } = setup();
    const control = recordingSandboxControl(
      { resume: (_threadId: string) => errAsync(failure as never) },
      context,
    );
    expect((await control.resume!('t1')).isErr()).toBe(true);
    expect(recorded[0]).toMatchObject({
      spec: { kind: 'sandbox.wake' },
      outcome: { ok: false, error: 'provider refused' },
    });
  });

  test('a destroy is recorded with its effect, for the owner read before it', async () => {
    const { recorded, context } = setup();
    const control = recordingSandboxControl(
      { destroy: (_threadId: string) => okAsync(undefined) },
      { ...context, destroyReason: 'thread-deleted', origin: 'implicit' },
    );
    await control.destroy!('t1');
    expect(recorded[0]).toMatchObject({
      spec: { kind: 'sandbox.destroy', userId: 'alice', input: { reason: 'thread-deleted' } },
      outcome: { ok: true, effects: [{ effect: 'sandbox-destroyed', target: 't1' }] },
    });
  });

  test('a release with nothing to free records nothing; one that frees is "released"', async () => {
    const { recorded, context } = setup();
    await recordingSandboxControl({ release: (_threadId: string) => okAsync(false) }, context)
      .release!('t1');
    expect(recorded).toHaveLength(0);
    await recordingSandboxControl({ release: (_threadId: string) => okAsync(true) }, context)
      .release!('t1');
    expect(recorded[0]!.spec.input).toEqual({ reason: 'released' });
  });

  test('no sandbox row, no activity', async () => {
    const { recorded, context } = setup(null);
    await recordingSandboxControl({ destroy: (_threadId: string) => okAsync(undefined) }, context)
      .destroy!('t1');
    expect(recorded).toHaveLength(0);
  });
});
