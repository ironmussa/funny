/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: command:status, command:output, command:metrics
 * @domain depends: ProjectManager, WSBroker, ShutdownManager
 *
 * CommandRunner — spawns and manages startup command processes.
 * Streams stdout/stderr to clients via WebSocket.
 * Supports auto-restart with exponential backoff for managed processes.
 */
import { execute } from '@funny/core/git';
import { runAsync, scheduleRepeating } from '@funny/shared/async';
import { internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';
import { getServices } from './service-registry.js';
import { wsBroker } from './ws-broker.js';

const KILL_GRACE_MS = 3_000;
const IS_WINDOWS = process.platform === 'win32';
const METRICS_INTERVAL_MS = 10_000;

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

export interface RestartOptions {
  autoRestart?: boolean;
  maxRestarts?: number;
  restartWindow?: number;
  restartCount?: number;
  restartHistory?: number[];
}

interface RunningCommand {
  proc: ReturnType<typeof Bun.spawn>;
  commandId: string;
  projectId: string;
  cwd: string;
  label: string;
  exited: boolean;
  /** Original command string (needed for restart) */
  command: string;
  /** Auto-restart on non-zero exit */
  autoRestart: boolean;
  /** Timestamp when this instance was started */
  startedAt: number;
  /** Total restart count (across all restarts) */
  restartCount: number;
  /** Max restarts within the restart window */
  maxRestarts: number;
  /** Restart window in ms */
  restartWindow: number;
  /** Timestamps of recent restarts (within window) */
  restartHistory: number[];
  /** Last sampled memory usage in KB (from ps) */
  memoryUsageKB: number;
  /** Whether stop was requested manually (suppresses auto-restart) */
  manualStop: boolean;
}

const activeCommands = new Map<string, RunningCommand>();
let metricsSchedule: ReturnType<typeof scheduleRepeating> | null = null;

async function emitWS(type: string, data: unknown, projectId?: string) {
  const event = { type, threadId: '', data } as any;
  // Look up project userId for per-user filtering
  if (projectId) {
    const project = await getServices().projects.getProject(projectId);
    if (project?.userId) {
      wsBroker.emitToUser(project.userId, event);
      return;
    }
  }
  log.warn('emitWS: could not resolve userId for project — dropping', {
    namespace: 'command-runner',
    projectId,
  });
}

export function startCommand(
  commandId: string,
  command: string,
  cwd: string,
  projectId: string,
  label: string,
  options?: RestartOptions,
): ResultAsync<void, DomainError> {
  return ResultAsync.fromPromise(
    startCommandImpl(commandId, command, cwd, projectId, label, options),
    (err) => internal(String((err as Error)?.message ?? err)),
  );
}

async function startCommandImpl(
  commandId: string,
  command: string,
  cwd: string,
  projectId: string,
  label: string,
  options?: RestartOptions,
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
    cwd,
    label,
    exited: false,
    command,
    autoRestart: options?.autoRestart ?? false,
    startedAt: Date.now(),
    restartCount: options?.restartCount ?? 0,
    maxRestarts: options?.maxRestarts ?? 5,
    restartWindow: options?.restartWindow ?? 60_000,
    restartHistory: options?.restartHistory ?? [],
    memoryUsageKB: 0,
    manualStop: false,
  };

  activeCommands.set(commandId, entry);
  ensureMetricsTimer();

  await emitWS(
    'command:status',
    {
      commandId,
      projectId,
      label,
      status: 'running',
      restartCount: entry.restartCount,
    },
    projectId,
  );

  // Stream stdout
  void readStream(proc.stdout as ReadableStream<Uint8Array>, commandId, 'stdout', projectId);
  // Stream stderr
  void readStream(proc.stderr as ReadableStream<Uint8Array>, commandId, 'stderr', projectId);

  // Handle exit
  proc.exited
    .then(async (exitCode) => {
      log.info(`Command "${label}" exited`, { namespace: 'command-runner', exitCode });
      entry.exited = true;

      // Auto-restart logic: restart on non-zero exit if configured
      if (entry.autoRestart && !entry.manualStop && exitCode !== 0) {
        const now = Date.now();
        const window = entry.restartWindow;

        // Clean old restart timestamps outside the window
        entry.restartHistory = entry.restartHistory.filter((t) => now - t < window);

        if (entry.restartHistory.length < entry.maxRestarts) {
          entry.restartHistory.push(now);
          const attempt = entry.restartHistory.length;
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);

          log.info(
            `Auto-restarting "${label}" in ${backoffMs}ms (restart ${attempt}/${entry.maxRestarts})`,
            { namespace: 'command-runner' },
          );

          activeCommands.delete(commandId);

          await emitWS(
            'command:status',
            {
              commandId,
              projectId,
              label,
              status: 'restarting',
              restartCount: entry.restartCount + 1,
              nextRestartMs: backoffMs,
              exitCode,
            },
            projectId,
          );

          setTimeout(() => {
            // Don't restart if it was manually started in the meantime
            if (activeCommands.has(commandId)) return;
            void startCommand(commandId, command, cwd, projectId, label, {
              autoRestart: true,
              maxRestarts: entry.maxRestarts,
              restartWindow: entry.restartWindow,
              restartCount: entry.restartCount + 1,
              restartHistory: entry.restartHistory,
            }).match(
              () => undefined,
              (e) =>
                log.warn('Auto-restart failed', {
                  namespace: 'command-runner',
                  commandId,
                  error: e.message,
                }),
            );
          }, backoffMs);
          return;
        }

        log.warn(`Max restarts reached for "${label}" — giving up`, {
          namespace: 'command-runner',
        });
      }

      activeCommands.delete(commandId);
      checkMetricsTimer();
      await emitWS(
        'command:status',
        {
          commandId,
          projectId,
          label,
          status: 'exited',
          exitCode,
          restartCount: entry.restartCount,
        },
        projectId,
      );
    })
    .catch(async (err) => {
      log.error(`Command "${label}" error`, { namespace: 'command-runner', error: err });
      entry.exited = true;
      activeCommands.delete(commandId);
      checkMetricsTimer();
      await emitWS(
        'command:status',
        {
          commandId,
          projectId,
          label,
          status: 'exited',
          exitCode: 1,
        },
        projectId,
      );
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
      await emitWS('command:output', { commandId, data: text, channel }, projectId);
    }
  } catch {
    // Stream closed — process likely killed
  }
}

export async function stopCommand(commandId: string): Promise<void> {
  const entry = activeCommands.get(commandId);
  if (!entry || entry.exited) return;

  log.info(`Stopping command "${entry.label}"`, { namespace: 'command-runner' });

  // Mark as manual stop to suppress auto-restart
  entry.manualStop = true;

  // On Windows, taskkill /T /F kills the entire process tree immediately,
  // so no grace period is needed. On Unix, try SIGTERM first, then SIGKILL.
  if (IS_WINDOWS) {
    killProcessTree(entry.proc);
  } else {
    killProcessTree(entry.proc); // SIGTERM

    const timeout = new Error('Command shutdown grace period expired');
    await runAsync(() => entry.proc.exited, {
      timeoutMs: KILL_GRACE_MS,
      timeoutError: () => timeout,
    }).catch((error) => {
      if (error !== timeout) throw error;
      if (!entry.exited) killProcessTree(entry.proc, 9);
    });
  }

  entry.exited = true;
  activeCommands.delete(commandId);
  checkMetricsTimer();

  await emitWS(
    'command:status',
    {
      commandId,
      projectId: entry.projectId,
      label: entry.label,
      status: 'stopped',
    },
    entry.projectId,
  );
}

export function getRunningCommands(): string[] {
  return Array.from(activeCommands.keys());
}

export function isCommandRunning(commandId: string): boolean {
  return activeCommands.has(commandId);
}

export function isCommandRunningForProject(commandId: string, projectId: string): boolean {
  const entry = activeCommands.get(commandId);
  return !!entry && !entry.exited && entry.projectId === projectId;
}

// ── Process Health Metrics ─────────────────────────────────

export function getCommandMetrics(commandId: string): {
  uptime: number;
  restartCount: number;
  memoryUsageKB: number;
} | null {
  const entry = activeCommands.get(commandId);
  if (!entry || entry.exited) return null;
  return {
    uptime: Date.now() - entry.startedAt,
    restartCount: entry.restartCount,
    memoryUsageKB: entry.memoryUsageKB,
  };
}

export function getCommandMetricsForProject(
  commandId: string,
  projectId: string,
): {
  uptime: number;
  restartCount: number;
  memoryUsageKB: number;
} | null {
  const entry = activeCommands.get(commandId);
  if (!entry || entry.exited || entry.projectId !== projectId) return null;
  return {
    uptime: Date.now() - entry.startedAt,
    restartCount: entry.restartCount,
    memoryUsageKB: entry.memoryUsageKB,
  };
}

/** Parse `ps -o pid=,rss=` output into pid → RSS (KB). */
export function parseRssByPid(stdout: string): Map<number, number> {
  const rssByPid = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const [pid, rss] = line
      .trim()
      .split(/\s+/)
      .map((value) => parseInt(value, 10));
    if (Number.isFinite(pid) && Number.isFinite(rss)) rssByPid.set(pid, rss);
  }
  return rssByPid;
}

/**
 * One async `ps` for all pids so sampling never blocks the event loop.
 * Missing pids (exited between check and call) are simply absent.
 */
export async function readRssByPid(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await execute('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
      reject: false,
      timeout: 5_000,
    });
    return parseRssByPid(stdout);
  } catch {
    // `ps` unavailable (e.g. Windows) — keep the previous samples.
    return new Map();
  }
}

async function sampleMetrics(): Promise<void> {
  const sampled = [...activeCommands.values()].filter((entry) => !entry.exited && entry.proc.pid);
  const rssByPid = await readRssByPid(sampled.map((entry) => entry.proc.pid!));
  for (const entry of sampled) {
    const rss = rssByPid.get(entry.proc.pid!);
    if (rss !== undefined) entry.memoryUsageKB = rss;
  }

  // Emit metrics for all running commands
  for (const [_id, entry] of activeCommands) {
    if (entry.exited) continue;
    // Fire-and-forget per command, but a failed project lookup / emit must not
    // become an unhandled rejection.
    emitWS(
      'command:metrics',
      {
        commandId: entry.commandId,
        projectId: entry.projectId,
        uptime: Date.now() - entry.startedAt,
        restartCount: entry.restartCount,
        memoryUsageKB: entry.memoryUsageKB,
      },
      entry.projectId,
    ).catch((err) =>
      log.warn('Command metrics emit failed', {
        namespace: 'command-runner',
        commandId: entry.commandId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function ensureMetricsTimer(): void {
  metricsSchedule ??= scheduleRepeating(sampleMetrics, METRICS_INTERVAL_MS, {
    onError: (err) =>
      log.warn('Command metrics sampling failed', {
        namespace: 'command-runner',
        error: err instanceof Error ? err.message : String(err),
      }),
  });
}

function checkMetricsTimer(): void {
  if (activeCommands.size === 0 && metricsSchedule) {
    metricsSchedule.stop();
    metricsSchedule = null;
  }
}

// ── Shutdown ───────────────────────────────────────────────

/** Kill all running commands. Called during shutdown. */
export async function stopAllCommands(): Promise<void> {
  const ids = [...activeCommands.keys()];
  if (ids.length === 0) return;
  metricsSchedule?.stop();
  metricsSchedule = null;
  await Promise.allSettled(ids.map((id) => stopCommand(id)));
}

/** Kill all running commands whose cwd starts with the given path. */
export async function stopCommandsByCwd(cwdPrefix: string): Promise<void> {
  const ids: string[] = [];
  for (const [id, entry] of activeCommands) {
    if (entry.cwd === cwdPrefix || entry.cwd.startsWith(cwdPrefix)) {
      ids.push(id);
    }
  }
  if (ids.length === 0) return;
  await Promise.allSettled(ids.map((id) => stopCommand(id)));
}

// ── Self-register with ShutdownManager ──────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register('command-runner', () => stopAllCommands(), ShutdownPhase.SERVICES);
