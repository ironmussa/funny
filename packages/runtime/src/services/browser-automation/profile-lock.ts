/**
 * Reclaim a Chromium profile left locked by an orphaned host.
 *
 * Chromium holds `--user-data-dir` with a `SingletonLock` symlink whose target
 * is `<hostname>-<pid>`. When the runtime dies without its shutdown hooks (a
 * `bun --watch` restart, a crash, SIGKILL) the Chromium it spawned keeps
 * running and keeps the lock, so every later launch on that profile exits
 * with code 21 ("SingletonLock: File exists") until someone kills it by hand.
 *
 * Before launching, the host asks this module to reclaim the profile: if the
 * lock points to a live process on this machine whose command line uses this
 * exact profile directory, it can only be a previous runtime's host (this
 * runtime has none for the profile, or it would not be launching) — stop it.
 * A lock held by anything else (another host, a process that does not use
 * the profile) is left alone and the launch fails as before.
 */

import { execFile } from 'child_process';
import { readlink, rm } from 'fs/promises';
import { hostname } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { log } from '../../lib/logger.js';

const NS = 'browser-host';
const execFileAsync = promisify(execFile);
const STOP_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;

export interface ProfileLockDeps {
  /** Target of the profile's `SingletonLock` symlink, or null when absent. */
  readLock(profileDir: string): Promise<string | null>;
  hostname(): string;
  /** Full command line of a live process, or null when it is not running. */
  commandOf(pid: number): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  removeLockFiles(profileDir: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Split a `SingletonLock` target (`<hostname>-<pid>`; the hostname may contain dashes). */
export function parseSingletonLock(target: string): { host: string; pid: number } | null {
  const match = /^(.+)-(\d+)$/.exec(target);
  if (!match) return null;
  const pid = Number(match[2]);
  return pid > 0 ? { host: match[1], pid } : null;
}

/** True when the lock is held by an orphaned Chromium host. Resolves after stopping it. */
export async function reclaimOrphanedProfile(
  profileDir: string,
  deps: ProfileLockDeps = defaultDeps,
): Promise<boolean> {
  const target = await deps.readLock(profileDir);
  const lock = target ? parseSingletonLock(target) : null;
  if (!lock || lock.host !== deps.hostname()) return false;

  const command = await deps.commandOf(lock.pid);
  if (!command || !command.includes(`--user-data-dir=${profileDir}`)) return false;

  log.warn('Stopping orphaned Chromium that still holds the browser profile', {
    namespace: NS,
    pid: lock.pid,
    profileDir,
  });
  deps.kill(lock.pid, 'SIGTERM');
  if (!(await waitForExit(lock.pid, deps))) {
    deps.kill(lock.pid, 'SIGKILL');
    await waitForExit(lock.pid, deps);
  }

  // A killed Chromium leaves its singleton files behind.
  await deps.removeLockFiles(profileDir);
  return true;
}

async function waitForExit(pid: number, deps: ProfileLockDeps): Promise<boolean> {
  for (let waited = 0; waited < STOP_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
    if (!(await deps.commandOf(pid))) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  return !(await deps.commandOf(pid));
}

const defaultDeps: ProfileLockDeps = {
  readLock: (profileDir) => readlink(join(profileDir, 'SingletonLock')).catch(() => null),
  hostname,
  commandOf: async (pid) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], {
        timeout: 2_000,
      });
      return stdout.trim() || null;
    } catch {
      return null; // ps exits non-zero when the pid is not running
    }
  },
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  removeLockFiles: async (profileDir) => {
    await Promise.all(
      ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) =>
        rm(join(profileDir, name), { force: true }).catch(() => {}),
      ),
    );
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
