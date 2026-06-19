import { spawn, type ChildProcess } from 'child_process';

import { killProcessTree } from '../agents/base-process.js';

/** True while `pid` is still a live process (signal 0 probes without killing). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

/**
 * Spawn a detached shell (the process-group leader) that backgrounds a
 * long-lived grandchild `sleep` and prints the grandchild's PID. This mirrors
 * how an ACP agent spawns MCP servers as its own children.
 */
function spawnTreeWithGrandchild(): Promise<{ child: ChildProcess; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const line = buf.split('\n')[0]?.trim();
      const pid = line ? Number(line) : NaN;
      if (Number.isInteger(pid) && pid > 0) {
        child.stdout?.off('data', onData);
        resolve({ child, grandchildPid: pid });
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
  });
}

describe('killProcessTree', () => {
  // POSIX-only: relies on `sh` + process groups. Windows uses taskkill /T,
  // which is exercised in CI on the Windows runner, not here.
  const maybe = process.platform === 'win32' ? test.skip : test;

  maybe('terminates the whole group, not just the immediate child', async () => {
    const { child, grandchildPid } = await spawnTreeWithGrandchild();
    try {
      expect(child.pid).toBeDefined();
      expect(isAlive(child.pid!)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      killProcessTree(child, 200);

      // The grandchild was backgrounded — killing only the leader pid would
      // orphan it (reparented to init, still alive). Its death proves the
      // process GROUP was signaled.
      expect(await waitUntilDead(grandchildPid)).toBe(true);
      expect(await waitUntilDead(child.pid!)).toBe(true);
    } finally {
      // Safety net if the assertion path threw before reaping.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  maybe('is a no-op when the child has no pid', () => {
    expect(() => killProcessTree({ pid: undefined } as unknown as ChildProcess)).not.toThrow();
  });
});
