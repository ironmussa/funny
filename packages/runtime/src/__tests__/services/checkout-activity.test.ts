/** `checkout.switch` records (track-funny-actions, design D5). */
import { describe, expect, test, vi } from 'bun:test';

import { recordCheckoutSwitch } from '../../services/checkout-activity.js';

const BASE = {
  userId: 'u1',
  projectId: 'p1',
  threadId: 't1',
  fromBranch: 'main',
  toBranch: 'develop',
  stashed: false,
  reason: 'thread-created' as const,
  origin: 'implicit' as const,
};

describe('recordCheckoutSwitch', () => {
  test('a switch records the branch it checked out, finished', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    await recordCheckoutSwitch(BASE, record);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'checkout.switch',
        origin: 'implicit',
        input: {
          fromBranch: 'main',
          toBranch: 'develop',
          stashed: false,
          reason: 'thread-created',
        },
      }),
      { ok: true, effects: [{ effect: 'branch-checked-out', target: 'develop' }] },
    );
  });

  test('a switch with a stash records both effects', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    await recordCheckoutSwitch({ ...BASE, stashed: true, reason: 'branch-checkout' }, record);
    expect(record.mock.calls[0]![1]).toEqual({
      ok: true,
      effects: [
        { effect: 'changes-stashed', target: 'main' },
        { effect: 'branch-checked-out', target: 'develop' },
      ],
    });
  });

  test('a stash that could not be restored is a failure', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    await recordCheckoutSwitch(
      { ...BASE, stashed: true, switched: false, error: 'conflict in stash pop' },
      record,
    );
    expect(record.mock.calls[0]![1]).toEqual({
      ok: false,
      error: 'conflict in stash pop',
      effects: [{ effect: 'changes-stashed', target: 'main' }],
    });
  });

  test('no activity when the branch does not change', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    await recordCheckoutSwitch({ ...BASE, toBranch: 'main' }, record);
    expect(record).not.toHaveBeenCalled();
  });
});
