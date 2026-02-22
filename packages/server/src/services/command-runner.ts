/**
 * CommandRunner — spawns and manages startup command processes.
 * Streams stdout/stderr to clients via WebSocket.
 * Follows the same pattern as agent-runner.ts + claude-process.ts.
 */

import { wsBroker } from './ws-broker.js';
import * as pm from './project-manager.js';
import { log } from '../lib/abbacchio.js';

const KILL_GRACE_MS = 3_000;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Kill a process tree on Windows using taskkill /T /F.
 * On Unix, proc.kill() already sends signals to the process group.
 */
function killProcessTree(proc: ReturnType<typeof Bun.spawn>, signal?: number): void {
  if (IS_WINDOWS) {
    try {
      Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${proc.pid} 2>nul`]);
    } catch {
      // Best-effort: process may have already exited
    }
  } else {
    try {
      proc.kill(signal);
    } catch {
      // Best-effort
    }
  }
}

interface RunningCommand {
  proc: ReturnType<typeof Bun.spawn>;
  commandId: string;
  projectId: string;
  label: string;
  exited: boolean;
}

const activeCommands = new Map<string, RunningCommand>();

function emitWS(type: string, data: unknown, projectId?: string) {
  const event = { type, threadId: '', data } as any;
  // Look up project userId for per-user filtering
  if (projectId) {
    const project = pm.getProject(projectId);
    if (project?.userId && project.userId !== '__local__') {
      wsBroker.emitToUser(project.userId, event);
      return;
    }
  }
  wsBroker.emit(event);
}

export async function startCommand(
  commandId: string,
  command: string,
  cwd: string,
  projectId: string,
  label: string,
): Promise<void> {
  // Kill existing instance of same command if running
  if (activeCommands.has(commandId)) {
    await stopCommand(commandId);
  }

  const shell = IS_WINDOWS ? 'cmd' : 'sh';
  const shellFlag = IS_WINDOWS ? '/c' : '-c';

  log.info(`Starting command "${label}"`, { namespace: 'command-runner', command, cwd });

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
  }, projectId);

  // Stream stdout
  readStream(proc.stdout as ReadableStream<Uint8Array>, commandId, 'stdout', projectId);
  // Stream stderr
  readStream(proc.stderr as ReadableStream<Uint8Array>, commandId, 'stderr', projectId);

  // Handle exit
  proc.exited
    .then((exitCode) => {
      log.info(`Command "${label}" exited`, { namespace: 'command-runner', exitCode });
      entry.exited = true;
      activeCommands.delete(commandId);
      emitWS('command:status', {
        commandId,
        projectId,
        label,
        status: 'exited',
        exitCode,
      }, projectId);
    })
    .catch((err) => {
      log.error(`Command "${label}" error`, { namespace: 'command-runner', error: err });
      entry.exited = true;
      activeCommands.delete(commandId);
      emitWS('command:status', {
        commandId,
        projectId,
        label,
        status: 'exited',
        exitCode: 1,
      }, projectId);
    });
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  commandId: string,
  channel: 'stdout' | 'stderr',
  projectId?: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      emitWS('command:output', { commandId, data: text, channel }, projectId);
    }
  } catch {
    // Stream closed — process likely killed
  }
}

export async function stopCommand(commandId: string): Promise<void> {
  const entry = activeCommands.get(commandId);
  if (!entry || entry.exited) return;

  log.info(`Stopping command "${entry.label}"`, { namespace: 'command-runner' });

  // On Windows, taskkill /T /F kills the entire process tree immediately,
  // so no grace period is needed. On Unix, try SIGTERM first, then SIGKILL.
  if (IS_WINDOWS) {
    killProcessTree(entry.proc);
  } else {
    killProcessTree(entry.proc); // SIGTERM

    await Promise.race([
      entry.proc.exited,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!entry.exited) {
            killProcessTree(entry.proc, 9); // SIGKILL
          }
          resolve();
        }, KILL_GRACE_MS)
      ),
    ]);
  }

  entry.exited = true;
  activeCommands.delete(commandId);

  emitWS('command:status', {
    commandId,
    projectId: entry.projectId,
    label: entry.label,
    status: 'stopped',
  }, entry.projectId);
}

export function getRunningCommands(): string[] {
  return Array.from(activeCommands.keys());
}

export function isCommandRunning(commandId: string): boolean {
  return activeCommands.has(commandId);
}

/** Kill all running commands. Called during shutdown. */
export async function stopAllCommands(): Promise<void> {
  const ids = [...activeCommands.keys()];
  if (ids.length === 0) return;
  await Promise.allSettled(ids.map((id) => stopCommand(id)));
}

// ── Self-register with ShutdownManager ──────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register('command-runner', () => stopAllCommands(), ShutdownPhase.SERVICES);
