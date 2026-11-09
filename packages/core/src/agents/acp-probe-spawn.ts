/**
 * Spawn a short-lived ACP CLI probe (model discovery) and wait
 * until it has actually started.
 *
 * Used by `acp-discover`. The child env is built with
 * `buildChildEnv`, so funny's infrastructure secrets are never inherited
 * (security M8). On POSIX the child leads its own process group so cleanup can
 * reap any helpers / MCP grandchildren it spawns.
 */
import { spawn, type ChildProcess } from 'child_process';

import { buildChildEnv } from '@funny/shared/lib/child-env';
import { ResultAsync } from 'neverthrow';

export function spawnAcpProbe(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): ResultAsync<ChildProcess, string> {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: buildChildEnv(env) as NodeJS.ProcessEnv,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  // Drain stderr so the child doesn't block on a full pipe buffer.
  child.stderr?.on('data', () => {});

  return ResultAsync.fromPromise(
    new Promise<ChildProcess>((resolve, reject) => {
      child.once('spawn', () => resolve(child));
      child.once('error', reject);
    }),
    (err) => (err as Error)?.message ?? String(err),
  );
}
