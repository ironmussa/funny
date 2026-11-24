/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 *
 * Command process ledger: a record on disk of the process groups the command
 * runner started.
 *
 * A command runs in its own process group, so it outlives a runner that is
 * killed without a clean shutdown (SIGKILL, OOM, power loss). The next runner
 * reads the ledger at startup and stops the groups whose runner is gone.
 *
 * A pid alone does not identify a process, because the kernel reuses pids. Each
 * entry also stores the start time of the command and of the runner that owns
 * it, and a process is touched only when both its pid and start time match.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execute } from '@funny/core/git';
import { internal, type DomainError } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

const NS = 'command-ledger';
const IS_WINDOWS = process.platform === 'win32';
const KILL_GRACE_MS = 3_000;
const KILL_POLL_MS = 100;

const entrySchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  ownerPid: z.number().int().positive(),
  ownerStartedAt: z.string().min(1),
  commandId: z.string(),
  label: z.string(),
  cwd: z.string(),
});

type LedgerEntry = z.infer<typeof entrySchema>;

export interface CommandProcess {
  pid: number;
  commandId: string;
  label: string;
  cwd: string;
}

export interface SweptCommand {
  pid: number;
  commandId: string;
  label: string;
  cwd: string;
}

export interface CommandProcessLedger {
  /** Record a command the runner just started. Never rejects. */
  record(command: CommandProcess): Promise<void>;
  /** Remove the record of a command that ended. Never rejects. */
  forget(pid: number): Promise<void>;
  /**
   * Stop the recorded commands whose runner is gone, and drop their records.
   * Call it once at startup, before this runner starts a command: a record that
   * names this process as its owner is taken to be from before a hot reload.
   */
  sweepOrphans(): ResultAsync<SweptCommand[], DomainError>;
}

interface LedgerDeps {
  dir: string;
  /** The runner that owns the commands this ledger records. */
  ownerPid: number;
  graceMs?: number;
}

/** Parse `ps -o pid=,lstart=` output into pid → start time. */
export function parseStartTimes(stdout: string): Map<number, string> {
  const startTimes = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match) startTimes.set(Number(match[1]), match[2]);
  }
  return startTimes;
}

/**
 * Start time of each live pid, in a fixed locale and time zone so that two
 * runners with different environments read the same text for one process.
 * A pid that is not running is absent.
 */
async function readStartTimes(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const { stdout } = await execute('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
    reject: false,
    timeout: 5_000,
    env: { LC_ALL: 'C', TZ: 'UTC' },
  });
  return parseStartTimes(stdout);
}

/** Signal the command's process group; the group is gone when this throws. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopGroup(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(KILL_POLL_MS);
  if (isAlive(pid)) signalGroup(pid, 'SIGKILL');
}

export function createCommandProcessLedger(deps: LedgerDeps): CommandProcessLedger {
  const { dir, ownerPid } = deps;
  const graceMs = deps.graceMs ?? KILL_GRACE_MS;
  const fileFor = (pid: number) => join(dir, `${pid}.json`);

  async function record(command: CommandProcess): Promise<void> {
    if (IS_WINDOWS) return;
    try {
      const startTimes = await readStartTimes([command.pid, ownerPid]);
      const startedAt = startTimes.get(command.pid);
      const ownerStartedAt = startTimes.get(ownerPid);
      // The command already ended: nothing to stop later.
      if (!startedAt || !ownerStartedAt) return;
      const entry: LedgerEntry = { ...command, startedAt, ownerPid, ownerStartedAt };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(fileFor(command.pid), JSON.stringify(entry), { mode: 0o600 });
    } catch (error) {
      log.warn('Could not record a command process', {
        namespace: NS,
        pid: command.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function forget(pid: number): Promise<void> {
    if (IS_WINDOWS) return;
    await rm(fileFor(pid), { force: true }).catch((error) =>
      log.warn('Could not remove a command process record', {
        namespace: NS,
        pid,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  async function readEntries(): Promise<{ entries: LedgerEntry[]; unreadable: string[] }> {
    const names = await readdir(dir).catch((): string[] => []);
    const entries: LedgerEntry[] = [];
    const unreadable: string[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const path = join(dir, name);
      const raw = await readFile(path, 'utf-8').catch(() => null);
      const parsed = raw === null ? null : parseStoredJson(entrySchema, raw, 'command process');
      // The file name is the key `forget` uses, so it must agree with the content.
      if (parsed?.ok && name === `${parsed.value.pid}.json`) entries.push(parsed.value);
      else unreadable.push(path);
    }
    return { entries, unreadable };
  }

  async function sweep(): Promise<SweptCommand[]> {
    if (IS_WINDOWS) return [];
    const { entries, unreadable } = await readEntries();
    await Promise.all(unreadable.map((path) => rm(path, { force: true })));
    if (entries.length === 0) return [];

    const startTimes = await readStartTimes([
      ...new Set(entries.flatMap((entry) => [entry.pid, entry.ownerPid])),
    ]);
    const swept: SweptCommand[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        const ownedByAnotherLiveRunner =
          entry.ownerPid !== ownerPid && startTimes.get(entry.ownerPid) === entry.ownerStartedAt;
        if (ownedByAnotherLiveRunner) return;
        // Same pid, same start time: still the command that was recorded.
        if (startTimes.get(entry.pid) === entry.startedAt) {
          await stopGroup(entry.pid, graceMs);
          swept.push({
            pid: entry.pid,
            commandId: entry.commandId,
            label: entry.label,
            cwd: entry.cwd,
          });
        }
        await rm(fileFor(entry.pid), { force: true });
      }),
    );

    if (swept.length > 0) {
      log.warn('Stopped commands left behind by a runner that did not shut down', {
        namespace: NS,
        count: swept.length,
        commands: swept.map((command) => ({
          pid: command.pid,
          label: command.label,
          cwd: command.cwd,
        })),
      });
      metric('command.orphans_swept', swept.length, { type: 'sum' });
    }
    return swept;
  }

  return {
    record,
    forget,
    sweepOrphans: () =>
      ResultAsync.fromPromise(sweep(), (error) =>
        // SAFETY: optional chaining plus `?? error` covers a rejection that is not an Error (no `message`).
        internal(String((error as Error)?.message ?? error)),
      ),
  };
}

export const commandProcessLedger = createCommandProcessLedger({
  dir: join(DATA_DIR, 'command-processes'),
  ownerPid: process.pid,
});
