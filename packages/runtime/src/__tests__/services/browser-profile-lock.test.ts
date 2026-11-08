import { describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  parseSingletonLock,
  reclaimOrphanedProfile,
  type ProfileLockDeps,
} from '../../services/browser-automation/profile-lock.js';

const PROFILE = '/home/u/.funny/browser-profiles/user-1/default';
const HOST = 'my-laptop-M5406WA';

function deps(overrides: Partial<ProfileLockDeps> & { running?: Map<number, string> }) {
  const running = overrides.running ?? new Map<number, string>();
  const base: ProfileLockDeps = {
    readLock: async () => `${HOST}-4242`,
    hostname: () => HOST,
    commandOf: async (pid) => running.get(pid) ?? null,
    kill: vi.fn((pid: number) => {
      running.delete(pid);
    }),
    removeLockFiles: vi.fn(async () => undefined),
    sleep: async () => undefined,
  };
  return { ...base, ...overrides };
}

describe('parseSingletonLock', () => {
  test('splits a hostname containing dashes from the pid', () => {
    expect(parseSingletonLock(`${HOST}-3028776`)).toEqual({ host: HOST, pid: 3028776 });
  });

  test('rejects targets without a pid', () => {
    expect(parseSingletonLock('garbage')).toBeNull();
  });
});

describe('reclaimOrphanedProfile', () => {
  test('stops an orphaned Chromium that holds this profile and clears its lock', async () => {
    const running = new Map([
      [4242, `/chrome --headless=new --user-data-dir=${PROFILE} about:blank`],
    ]);
    const d = deps({ running });

    expect(await reclaimOrphanedProfile(PROFILE, d)).toBe(true);
    expect(d.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(d.removeLockFiles).toHaveBeenCalledWith(PROFILE);
  });

  test('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const running = new Map([[4242, `/chrome --user-data-dir=${PROFILE}`]]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') running.delete(pid);
    });
    const d = deps({ running, kill });

    expect(await reclaimOrphanedProfile(PROFILE, d)).toBe(true);
    expect(kill.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('leaves a process alone when it does not use this profile', async () => {
    const running = new Map([[4242, '/usr/bin/vim notes.txt']]);
    const d = deps({ running });

    expect(await reclaimOrphanedProfile(PROFILE, d)).toBe(false);
    expect(d.kill).not.toHaveBeenCalled();
  });

  test('leaves a lock taken on another machine alone', async () => {
    const running = new Map([[4242, `/chrome --user-data-dir=${PROFILE}`]]);
    const d = deps({ running, readLock: async () => 'other-host-4242' });

    expect(await reclaimOrphanedProfile(PROFILE, d)).toBe(false);
    expect(d.kill).not.toHaveBeenCalled();
  });

  test('does nothing when the profile is not locked', async () => {
    const d = deps({ readLock: async () => null });

    expect(await reclaimOrphanedProfile(PROFILE, d)).toBe(false);
    expect(d.removeLockFiles).not.toHaveBeenCalled();
  });
});
