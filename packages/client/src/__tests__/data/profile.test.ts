import type { UserProfile } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/api/profile', () => ({
  profileApi: {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    completeSetup: vi.fn(),
  },
}));

import { completeSetup, updateProfile } from '@/data/profile/actions';
import { loadProfile, profileQuery, refreshProfile } from '@/data/profile/queries';
import { getDataLayer } from '@/data/runtime';
import { profileApi } from '@/lib/api/profile';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const mockApi = vi.mocked(profileApi);

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'profile-1',
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
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    ...overrides,
  };
}

const cached = () => getDataLayer().queryClient.getQueryData<UserProfile>(profileQuery().queryKey);

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('profile query', () => {
  test('concurrent loads share one request and later loads reuse it', async () => {
    mockApi.getProfile.mockReturnValue(okAsync(makeProfile()));

    await Promise.all([loadProfile(), loadProfile()]);
    await loadProfile();

    expect(mockApi.getProfile).toHaveBeenCalledTimes(1);
  });

  test('a failed load rejects and caches nothing, so a retry asks again', async () => {
    mockApi.getProfile.mockReturnValueOnce(
      errAsync({ type: 'INTERNAL', message: 'down' } as DomainError),
    );
    await expect(loadProfile()).rejects.toThrow('down');
    expect(cached()).toBeUndefined();

    mockApi.getProfile.mockReturnValueOnce(okAsync(makeProfile()));
    await loadProfile();
    expect(mockApi.getProfile).toHaveBeenCalledTimes(2);
  });

  // Regression: saving the AssemblyAI key left the old profile cached, so the
  // dictation button stayed hidden until a page reload.
  test('a saved profile write replaces the cached profile', async () => {
    mockApi.getProfile.mockReturnValue(okAsync(makeProfile()));
    await loadProfile();

    mockApi.updateProfile.mockReturnValue(
      okAsync(makeProfile({ hasAssemblyaiKey: true, providerKeys: { assemblyai: true } })),
    );
    await updateProfile({ providerKey: { id: 'assemblyai', value: 'key' } });

    expect(cached()?.hasAssemblyaiKey).toBe(true);
    expect(cached()?.providerKeys).toEqual({ assemblyai: true });
  });

  test('a failed write leaves the cached profile untouched', async () => {
    const profile = makeProfile();
    mockApi.getProfile.mockReturnValue(okAsync(profile));
    await loadProfile();

    mockApi.updateProfile.mockReturnValue(
      errAsync({ type: 'INTERNAL', message: 'nope' } as DomainError),
    );
    const result = await updateProfile({ theme: 'one-light' });

    expect(result.isErr()).toBe(true);
    expect(cached()).toBe(profile);
  });

  test('completing setup records the returned profile', async () => {
    mockApi.completeSetup.mockReturnValue(okAsync(makeProfile({ setupCompleted: true })));
    await completeSetup();
    expect(cached()?.setupCompleted).toBe(true);
  });

  test('refresh re-reads the profile and keeps the old copy on failure', async () => {
    mockApi.getProfile.mockReturnValueOnce(okAsync(makeProfile({ theme: 'a' })));
    await loadProfile();

    mockApi.getProfile.mockReturnValueOnce(okAsync(makeProfile({ theme: 'b' })));
    await refreshProfile();
    expect(cached()?.theme).toBe('b');

    mockApi.getProfile.mockReturnValueOnce(
      errAsync({ type: 'INTERNAL', message: 'down' } as DomainError),
    );
    await refreshProfile();
    expect(cached()?.theme).toBe('b');
  });

  test('a new session starts without a profile', async () => {
    mockApi.getProfile.mockReturnValue(okAsync(makeProfile()));
    await loadProfile();

    installTestDataLayer('user-2');
    expect(cached()).toBeUndefined();
  });
});
