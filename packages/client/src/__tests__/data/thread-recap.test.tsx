import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { UserProfile } from '@funny/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

const generate = vi.fn();
mock.module('@/data/thread-recap/api', () => ({
  threadRecapApi: { generate },
  UTILITY_MODEL_UNAVAILABLE: 'utility-model-unavailable',
}));

mock.module('@/lib/api/profile', () => ({
  profileApi: {
    getProfile: () => errAsync({ type: 'INTERNAL', message: 'offline in tests' }),
    updateProfile: vi.fn(),
    completeSetup: vi.fn(),
  },
}));

import { writeProfile } from '@/data/profile/queries';
import { resyncDataLayer } from '@/data/resync';
import { useThreadRecap, type RecapOpen } from '@/data/thread-recap/hooks';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const thread = { id: 't1', userId: 'user-1', createdAt: minutesAgo(120), runtime: 'local' };

function opened(overrides: Partial<RecapOpen> = {}): RecapOpen {
  return {
    readAt: minutesAgo(20),
    openedAt: NOW,
    createdAt: thread.createdAt,
    newestMessageId: 'm9',
    newestActivityAt: minutesAgo(1),
    ...overrides,
  };
}

function seedProfile(overrides: Partial<UserProfile> = {}) {
  writeProfile({
    userId: 'user-1',
    gitName: null,
    gitEmail: null,
    providerKeys: {},
    hasGithubToken: false,
    hasAssemblyaiKey: false,
    hasMinimaxApiKey: false,
    setupCompleted: true,
    defaultEditor: null,
    useInternalEditor: null,
    terminalShell: null,
    toolPermissions: null,
    theme: null,
    runnerInviteToken: null,
    utilityModel: null,
    threadRecapEnabled: true,
    threadRecapMinAbsenceMinutes: 5,
    ...overrides,
  } as UserProfile);
}

const notDismissed = () => false;

beforeEach(() => {
  generate.mockReset();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('useThreadRecap', () => {
  test('asks for a recap since the read marker and shows it', async () => {
    seedProfile();
    generate.mockReturnValue(okAsync({ recap: 'Did things.', newestMessageId: 'm9' }));

    const { result } = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));

    await waitFor(() =>
      expect(result.current).toEqual({ state: 'ready', key: 't1:m9', recap: 'Did things.' }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith('t1', {
      since: minutesAgo(20),
      newestMessageId: 'm9',
      language: expect.any(String),
    });
  });

  test('reopening the thread with no new activity sends no second request', async () => {
    seedProfile();
    generate.mockReturnValue(okAsync({ recap: 'Did things.', newestMessageId: 'm9' }));

    const first = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() => expect(first.result.current.state).toBe('ready'));
    first.unmount();

    // Reopened later: a new open snapshot, same newest message.
    const second = renderHook(() =>
      useThreadRecap(thread, 'user-1', opened({ openedAt: NOW + 60_000 }), notDismissed),
    );
    await waitFor(() => expect(second.result.current.state).toBe('ready'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('a newer message asks again', async () => {
    seedProfile();
    generate.mockReturnValue(okAsync({ recap: 'Did things.', newestMessageId: 'x' }));
    const first = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() => expect(first.result.current.state).toBe('ready'));
    first.unmount();

    const second = renderHook(() =>
      useThreadRecap(thread, 'user-1', opened({ newestMessageId: 'm10' }), notDismissed),
    );
    await waitFor(() => expect(second.result.current.state).toBe('ready'));
    expect(generate).toHaveBeenCalledTimes(2);
  });

  test('with threadRecapEnabled false no recap request is sent', async () => {
    seedProfile({ threadRecapEnabled: false });
    generate.mockReturnValue(okAsync({ recap: 'x', newestMessageId: 'm9' }));

    const { result } = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ state: 'hidden' });
    expect(generate).not.toHaveBeenCalled();
  });

  test('the profile absence decides whether an open asks for a recap', async () => {
    // Read 20 minutes ago: not enough for a 30-minute absence.
    seedProfile({ threadRecapMinAbsenceMinutes: 30 });
    generate.mockReturnValue(okAsync({ recap: 'x', newestMessageId: 'm9' }));
    const short = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await new Promise((r) => setTimeout(r, 20));
    expect(short.result.current).toEqual({ state: 'hidden' });
    expect(generate).not.toHaveBeenCalled();
    short.unmount();

    // Read 2 minutes ago: enough for a 1-minute absence.
    seedProfile({ threadRecapMinAbsenceMinutes: 1 });
    const long = renderHook(() =>
      useThreadRecap(thread, 'user-1', opened({ readAt: minutesAgo(2) }), notDismissed),
    );
    await waitFor(() => expect(long.result.current.state).toBe('ready'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('no request before the profile is known', async () => {
    renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await new Promise((r) => setTimeout(r, 20));
    expect(generate).not.toHaveBeenCalled();
  });

  test('a sharee, a sandbox thread, a short absence or no new activity send nothing', async () => {
    seedProfile();
    generate.mockReturnValue(okAsync({ recap: 'x', newestMessageId: 'm9' }));
    const cases = [
      () => useThreadRecap(thread, 'user-2', opened(), notDismissed),
      () => useThreadRecap({ ...thread, runtime: 'sandbox' }, 'user-1', opened(), notDismissed),
      () => useThreadRecap(thread, 'user-1', opened({ readAt: minutesAgo(2) }), notDismissed),
      () =>
        useThreadRecap(
          thread,
          'user-1',
          opened({ newestActivityAt: minutesAgo(30) }),
          notDismissed,
        ),
      () => useThreadRecap(thread, 'user-1', undefined, notDismissed),
      () => useThreadRecap(thread, 'user-1', opened(), () => true),
    ];
    for (const hook of cases) {
      const { result } = renderHook(hook);
      expect(result.current).toEqual({ state: 'hidden' });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(generate).not.toHaveBeenCalled();
  });

  test('a missing credential is reported once and stops further requests', async () => {
    seedProfile();
    generate.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'utility-model-unavailable' }));
    const first = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() =>
      expect(first.result.current).toEqual({ state: 'unavailable', key: 't1:m9' }),
    );

    const other = renderHook(() =>
      useThreadRecap({ ...thread, id: 't2' }, 'user-1', opened(), notDismissed),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(other.result.current).toEqual({ state: 'hidden' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('any other failure shows nothing', async () => {
    seedProfile();
    generate.mockReturnValue(errAsync({ type: 'NOT_FOUND', message: 'Not found' }));
    const { result } = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toEqual({ state: 'hidden' });
  });

  test('reopening after a failed recap does not generate it again', async () => {
    seedProfile();
    generate.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'timeout' }));
    const first = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    first.unmount();

    // Reopened with no new activity: the same (thread, newest message) failed already.
    const second = renderHook(() =>
      useThreadRecap(thread, 'user-1', opened({ openedAt: NOW + 60_000 }), notDismissed),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current).toEqual({ state: 'hidden' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('a realtime resync does not regenerate a recap', async () => {
    seedProfile();
    generate.mockReturnValue(okAsync({ recap: 'Did things.', newestMessageId: 'm9' }));
    const first = renderHook(() => useThreadRecap(thread, 'user-1', opened(), notDismissed));
    await waitFor(() => expect(first.result.current.state).toBe('ready'));

    // Reconnect while the card is shown, then reopen the thread later.
    await resyncDataLayer();
    first.unmount();
    const second = renderHook(() =>
      useThreadRecap(thread, 'user-1', opened({ openedAt: NOW + 60_000 }), notDismissed),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current).toEqual({ state: 'ready', key: 't1:m9', recap: 'Did things.' });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
