/**
 * CommandRunner — spawns and manages startup command processes.
 * Streams stdout/stderr to clients via WebSocket.
 * Follows the same pattern as agent-runner.ts + claude-process.ts.
 */

import { wsBroker } from './ws-broker.js';

const KILL_GRACE_MS = 3_000;

interface RunningCommand {
  proc: ReturnType<typeof Bun.spawn>;
  commandId: string;
  projectId: string;
  label: string;
  exited: boolean;
}

const activeCommands = new Map<string, RunningCommand>();

function emitWS(type: string, data: unknown) {
  wsBroker.emit({ type, threadId: '', data } as any);
}

export function startCommand(
  commandId: string,
  command: string,
  cwd: string,
  projectId: string,
  label: string
): void {
  // Kill existing instance of same command if running
  if (activeCommands.has(commandId)) {
    stopCommand(commandId);
  }

  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';

  console.log(`[command-runner] Starting "${label}": ${command} in ${cwd}`);

  const proc = Bun.spawn([shell, shellFlag, command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const entry: RunningCommand = {
    proc,
    commandId,
    projectId,
    label,
    exited: false,
  };

  activeCommands.set(commandId, entry);

  emitWS('command:status', {
    commandId,
    projectId,
    label,
    status: 'running',
  });

  // Stream stdout
  readStream(proc.stdout as ReadableStream<Uint8Array>, commandId, 'stdout');
  // Stream stderr
  readStream(proc.stderr as ReadableStream<Uint8Array>, commandId, 'stderr');

  // Handle exit
  proc.exited
    .then((exitCode) => {
      console.log(`[command-runner] "${label}" exited with code ${exitCode}`);
      entry.exited = true;
      activeCommands.delete(commandId);
      emitWS('command:status', {
        commandId,
        projectId,
        label,
        status: 'exited',
        exitCode,
      });
    })
    .catch((err) => {
      console.error(`[command-runner] "${label}" error:`, err);
      entry.exited = true;
      activeCommands.delete(commandId);
      emitWS('command:status', {
        commandId,
        projectId,
        label,
        status: 'exited',
        exitCode: 1,
      });
    });
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  commandId: string,
  channel: 'stdout' | 'stderr'
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      emitWS('command:output', { commandId, data: text, channel });
    }
  } catch {
    // Stream closed — process likely killed
  }
}

export async function stopCommand(commandId: string): Promise<void> {
  const entry = activeCommands.get(commandId);
  if (!entry || entry.exited) return;

  console.log(`[command-runner] Stopping "${entry.label}"`);

  entry.proc.kill(); // SIGTERM

  await Promise.race([
    entry.proc.exited,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!entry.exited) {
          entry.proc.kill(9); // SIGKILL
        }
        resolve();
      }, KILL_GRACE_MS)
    ),
  ]);

  entry.exited = true;
  activeCommands.delete(commandId);

  emitWS('command:status', {
    commandId,
    projectId: entry.projectId,
    label: entry.label,
    status: 'stopped',
  });
}

export function getRunningCommands(): string[] {
  return Array.from(activeCommands.keys());
}

export function isCommandRunning(commandId: string): boolean {
  return activeCommands.has(commandId);
}
