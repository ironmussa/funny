import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCommandProcessLedger,
  parseStartTimes,
} from '../../services/command-process-ledger.js';

type Child = ReturnType<typeof Bun.spawn>;

/** How long a killed process may take to be reaped before a test gives up on it. */
const EXIT_WAIT_MS = 5_000;

describe('parseStartTimes', () => {
  test('reads one start time per pid and skips other lines', () => {
    const startTimes = parseStartTimes(
      ['  812 Mon Nov 23 11:30:00 2026', '', '90210 Fri Nov 20 01:50:30 2026  ', 'noise'].join(
        '\n',
      ),
    );
    expect([...startTimes]).toEqual([
      [812, 'Mon Nov 23 11:30:00 2026'],
      [90210, 'Fri Nov 20 01:50:30 2026'],
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('command process ledger', () => {
  let dir: string;
  let children: Child[];

  /** A process that ends by itself, so a killed test run leaves nothing behind. */
  function spawnSleeper(): Child {
    const child = Bun.spawn(['sleep', '30'], { detached: true, stdout: 'ignore' });
    children.push(child);
    return child;
  }

  async function exitedWithin(child: Child, ms: number): Promise<boolean> {
    return Promise.race([child.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  }

  const command = (child: Child) => ({
    pid: child.pid,
    commandId: 'cmd-1',
    label: 'Dev server',
    cwd: '/repo',
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'command-ledger-'));
    children = [];
  });

  afterEach(async () => {
    for (const child of children) {
      child.kill(9);
      await child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('stops a command whose runner is gone', async () => {
    const oldRunner = spawnSleeper();
    const orphan = spawnSleeper();
    await createCommandProcessLedger({ dir, ownerPid: oldRunner.pid }).record(command(orphan));
    oldRunner.kill(9);
    await oldRunner.exited;

    const swept = await createCommandProcessLedger({ dir, ownerPid: process.pid }).sweepOrphans();

    expect(swept._unsafeUnwrap()).toEqual([command(orphan)]);
    expect(await exitedWithin(orphan, EXIT_WAIT_MS)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('leaves a command whose runner is still running', async () => {
    const otherRunner = spawnSleeper();
    const theirs = spawnSleeper();
    await createCommandProcessLedger({ dir, ownerPid: otherRunner.pid }).record(command(theirs));

    const swept = await createCommandProcessLedger({ dir, ownerPid: process.pid }).sweepOrphans();

    expect(swept._unsafeUnwrap()).toEqual([]);
    expect(await exitedWithin(theirs, 300)).toBe(false);
    expect(readdirSync(dir)).toEqual([`${theirs.pid}.json`]);
  });

  test('stops a command this process recorded before a hot reload', async () => {
    const fromBeforeReload = spawnSleeper();
    const ledger = createCommandProcessLedger({ dir, ownerPid: process.pid });
    await ledger.record(command(fromBeforeReload));

    const swept = await ledger.sweepOrphans();

    expect(swept._unsafeUnwrap()).toHaveLength(1);
    expect(await exitedWithin(fromBeforeReload, EXIT_WAIT_MS)).toBe(true);
  });

  test('does not touch a process that reuses the pid of a recorded command', async () => {
    const oldRunner = spawnSleeper();
    const unrelated = spawnSleeper();
    await createCommandProcessLedger({ dir, ownerPid: oldRunner.pid }).record(command(unrelated));
    oldRunner.kill(9);
    await oldRunner.exited;
    // The recorded command started at another time: this pid now names another process.
    const file = join(dir, `${unrelated.pid}.json`);
    const entry = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...entry, startedAt: 'Thu Jan  1 00:00:00 1970' }));

    const swept = await createCommandProcessLedger({ dir, ownerPid: process.pid }).sweepOrphans();

    expect(swept._unsafeUnwrap()).toEqual([]);
    expect(await exitedWithin(unrelated, 300)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('drops a record it cannot read', async () => {
    writeFileSync(join(dir, '123.json'), '{not json');
    writeFileSync(join(dir, '456.json'), JSON.stringify({ pid: 'x' }));

    const swept = await createCommandProcessLedger({ dir, ownerPid: process.pid }).sweepOrphans();

    expect(swept._unsafeUnwrap()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('forgets a command that ended', async () => {
    const child = spawnSleeper();
    const ledger = createCommandProcessLedger({ dir, ownerPid: process.pid });
    await ledger.record(command(child));
    expect(readdirSync(dir)).toEqual([`${child.pid}.json`]);

    await ledger.forget(child.pid);

    expect(readdirSync(dir)).toEqual([]);
  });

  test('records nothing for a command that already ended', async () => {
    const ended = Bun.spawn(['true'], { stdout: 'ignore' });
    await ended.exited;

    await createCommandProcessLedger({ dir, ownerPid: process.pid }).record(command(ended));

    expect(readdirSync(dir)).toEqual([]);
  });
});
