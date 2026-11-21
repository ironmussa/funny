import type { WSAgentAccountData } from '@funny/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  accountKey,
  applyAgentAccountEvent,
  getAgentAccountStore,
  getThreadAccountStore,
  restoreAgentAccounts,
} from '@/data/agent-account/store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const usage = { windows: [{ key: 'five_hour', utilization: 40, resetsAt: null }] };
const event = (over: Partial<WSAgentAccountData> = {}): WSAgentAccountData => ({
  profileId: 'p1',
  profileName: 'Work',
  account: { email: 'work@example.com', subscriptionType: 'max' },
  usage,
  ...over,
});

beforeEach(() => {
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('agent account store', () => {
  test('keys the account by profile and links the thread to it', () => {
    applyAgentAccountEvent('t1', event(), 1000);
    applyAgentAccountEvent('t2', event({ profileId: null, profileName: null }), 1000);

    expect(getAgentAccountStore().read('profile:p1')?.usage).toEqual(usage);
    expect(getThreadAccountStore().read('t1')?.accountKey).toBe('profile:p1');
    expect(getThreadAccountStore().read('t2')?.accountKey).toBe(accountKey(null));
  });

  test('a later event from another thread updates the shared account usage', () => {
    applyAgentAccountEvent('t1', event(), 1000);
    const next = { windows: [{ key: 'five_hour', utilization: 55, resetsAt: null }] };
    applyAgentAccountEvent('t2', event({ usage: next }), 2000);

    const row = getAgentAccountStore().read('profile:p1');
    expect(row?.usage).toEqual(next);
    expect(row?.capturedAt).toBe(2000);
  });

  test('an event without usage keeps the last usage of the same login', () => {
    applyAgentAccountEvent('t1', event(), 1000);
    applyAgentAccountEvent('t1', event({ usage: undefined }), 2000);

    const row = getAgentAccountStore().read('profile:p1');
    expect(row?.usage).toEqual(usage);
    expect(row?.capturedAt).toBe(1000);
  });

  test('a different login on the profile drops the old usage', () => {
    applyAgentAccountEvent('t1', event(), 1000);
    applyAgentAccountEvent(
      't1',
      event({ account: { email: 'other@example.com' }, usage: undefined }),
      2000,
    );

    expect(getAgentAccountStore().read('profile:p1')?.usage).toBeUndefined();
  });

  test('restores persisted rows only into an empty session', () => {
    const saved = applyAgentAccountEvent('t1', event(), 1000);
    resetTestDataLayer();
    installTestDataLayer();

    restoreAgentAccounts(() => saved);
    expect(getAgentAccountStore().read('profile:p1')?.usage).toEqual(usage);

    restoreAgentAccounts(() => []);
    expect(getAgentAccountStore().read('profile:p1')).toBeDefined();
  });
});
