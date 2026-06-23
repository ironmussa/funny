/**
 * @domain subdomain: Jobs
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: RuntimeServiceProvider, ThreadMessaging, WSBroker, AgentWatcherManager
 *
 * Agent jobs — funny-owned detached background processes launched via the
 * `funny_spawn` tool.
 *
 * The process is launched with Node's `detached: true` (the session-leader /
 * setsid equivalent) + `unref()` + stdio closed, so it leaves the agent/runner
 * process subtree and is reparented to init — surviving turn end, harness
 * reaping, and runner restart. Output goes to a logfile; a wrapper writes
 * `EXIT=$?` to an exitfile on completion.
 *
 * Status is re-derived (NOT held as a child handle) from the exitfile + pid
 * liveness, so it survives a runner restart. The same heartbeat cadence as the
 * watcher scanner polls running jobs and wakes the agent on completion.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { open, stat } from 'fs/promises';
import { join } from 'path';

import type {
  AgentModel,
  Job,
  JobLogChunk,
  JobStatus,
  PermissionMode,
  WSEvent,
} from '@funny/shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_PROVIDER } from '@funny/shared/models';
import { nanoid } from 'nanoid';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { isAgentRunning, startAgent } from './agent-runner-control.js';
import { createOrReschedule } from './agent-watcher-manager.js';
import { buildLogTail } from './job-log-tail.js';
import { getServices } from './service-registry.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { resolveThreadCwd } from './thread-context.js';
import { wsBroker } from './ws-broker.js';

const HEARTBEAT_MS = 5_000;
const MAX_LOG_READ_BYTES = 128 * 1024;
const NS = 'agent-job';

let scanner: ReturnType<typeof setInterval> | null = null;
let scanning = false;

function jobDir(id: string): string {
  return join(DATA_DIR, 'jobs', id);
}

function emit(
  userId: string,
  type: 'job:created' | 'job:exited' | 'job:killed' | 'job:cancelled',
  job: Job,
): void {
  wsBroker.emitToUser(userId, { type, threadId: job.threadId, data: { job } } as WSEvent);
}

// ── Spawn ────────────────────────────────────────────────────────

export interface SpawnArgs {
  threadId: string;
  userId: string;
  command: string;
  cwd?: string;
  label?: string;
  /** If set, also schedule a watcher to wake the agent mid-run after N minutes. */
  wakeInMinutes?: number;
}

export async function spawnJob(args: SpawnArgs): Promise<Job> {
  const id = nanoid();
  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'log');
  const exitPath = join(dir, 'exit');

  // Wrapper: run the command with stdout+stderr to the logfile, then record the
  // exit code. The exitfile's presence/absence is what later distinguishes a
  // clean finish from an external kill.
  const wrapper = `(${args.command}) > "${logPath}" 2>&1; echo "EXIT=$?" > "${exitPath}"`;

  // detached:true → new session/group leader (setsid equivalent); stdio ignored
  // and unref() so the process is fully decoupled and survives the runner.
  const child = spawn('bash', ['-c', wrapper], {
    cwd: args.cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid ?? null;

  const now = new Date().toISOString();
  const job: Job = {
    id,
    threadId: args.threadId,
    userId: args.userId,
    command: args.command,
    cwd: args.cwd ?? null,
    label: args.label ?? null,
    pid,
    logPath,
    exitPath,
    status: 'running',
    exitCode: null,
    startedAt: now,
    updatedAt: now,
  };
  await getServices().jobs.insertJob(job);
  emit(args.userId, 'job:created', job);
  log.info('Job spawned', { namespace: NS, jobId: id, pid, label: args.label });

  if (args.wakeInMinutes && args.wakeInMinutes > 0) {
    await createOrReschedule({
      threadId: args.threadId,
      userId: args.userId,
      key: `job:${id}`,
      label: args.label ? `job ${args.label}` : `job ${id}`,
      delayMs: Math.round(args.wakeInMinutes * 60_000),
    });
  }

  return job;
}

// ── Status detection (restart-robust: exitfile + pid liveness) ────

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function deriveStatus(job: Pick<Job, 'pid' | 'exitPath'>): {
  status: JobStatus;
  exitCode: number | null;
} {
  if (existsSync(job.exitPath)) {
    const m = readFileSync(job.exitPath, 'utf8').match(/EXIT=(-?\d+)/);
    const code = m ? parseInt(m[1], 10) : null;
    return code === 0 ? { status: 'exited', exitCode: 0 } : { status: 'failed', exitCode: code };
  }
  if (job.pid != null && isAlive(job.pid)) return { status: 'running', exitCode: null };
  // No exit marker and the process is gone → killed before it could record exit.
  return { status: 'killed', exitCode: null };
}

// ── Scanner (poll running jobs → detect completion → wake) ────────

async function scanOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const running = (await getServices().jobs.listRunningJobs()) as Job[];
    for (const job of running) {
      const { status, exitCode } = deriveStatus(job);
      if (status === 'running') continue;
      await onTerminal(job, status, exitCode).catch((err) =>
        log.error('Job completion handling failed', {
          namespace: NS,
          jobId: job.id,
          error: (err as Error).message,
        }),
      );
    }
  } catch (err) {
    log.error('Job scan failed', { namespace: NS, error: (err as Error).message });
  } finally {
    scanning = false;
  }
}

async function onTerminal(job: Job, status: JobStatus, exitCode: number | null): Promise<void> {
  await getServices().jobs.updateJob(job.id, { status, exitCode });
  const finished: Job = { ...job, status, exitCode };
  emit(job.userId, status === 'killed' ? 'job:killed' : 'job:exited', finished);
  log.info('Job finished', { namespace: NS, jobId: job.id, status, exitCode });

  const completion = renderCompletion(finished);
  await persistCompletionToolCard(finished, completion);

  // Wake an idle agent with the verdict + log tail without persisting a user
  // message. If a turn is already running, the visible tool card is enough; do
  // not enqueue a synthetic "user" follow-up that will later render as user text.
  if (isAgentRunning(job.threadId)) return;
  await wakeAgentWithCompletion(finished, completion).catch((err) => {
    log.error('Job wake failed to start agent', {
      namespace: NS,
      jobId: job.id,
      error: (err as Error).message,
    });
  });
}

async function persistCompletionToolCard(job: Job, output: string): Promise<void> {
  const messageId = await getServices().threads.insertMessage({
    threadId: job.threadId,
    role: 'assistant',
    content: '',
    author: 'background',
  });
  const input = renderCompletionToolInput(job);
  const toolCallId = await getServices().threads.insertToolCall({
    messageId,
    name: 'Background',
    input: JSON.stringify(input),
    author: 'background',
  });
  await getServices().threads.updateToolCallOutput(toolCallId, output);

  emitTool(job.userId, job.threadId, {
    type: 'agent:tool_call',
    data: { toolCallId, messageId, name: 'Background', input, author: 'background' },
  });
  emitTool(job.userId, job.threadId, {
    type: 'agent:tool_output',
    data: { toolCallId, output },
  });
}

function emitTool(
  userId: string,
  threadId: string,
  event:
    | {
        type: 'agent:tool_call';
        data: {
          toolCallId: string;
          messageId: string;
          name: string;
          input: Record<string, unknown>;
          author: string;
        };
      }
    | { type: 'agent:tool_output'; data: { toolCallId: string; output: string } },
): void {
  wsBroker.emitToUser(userId, { ...event, threadId } as WSEvent);
}

async function wakeAgentWithCompletion(job: Job, prompt: string): Promise<void> {
  const thread = await getServices().threads.getThread(job.threadId);
  if (!thread) throw new Error('Thread not found');

  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project ? { path: project.path } : null,
  );
  if (cwdResult.isErr()) throw new Error(cwdResult.error.message);

  await startAgent(
    job.threadId,
    prompt,
    cwdResult.value,
    (thread.model || DEFAULT_MODEL) as AgentModel,
    (thread.permissionMode || DEFAULT_PERMISSION_MODE) as PermissionMode,
    undefined,
    undefined,
    undefined,
    thread.provider || DEFAULT_PROVIDER,
    undefined,
    true,
  );
}

function tailLog(logPath: string, maxLines = 50): string {
  if (!existsSync(logPath)) return '(no output captured)';
  return buildLogTail(readFileSync(logPath, 'utf8'), maxLines);
}

function renderCompletion(job: Job): string {
  const name = job.label ? `"${job.label}"` : `job ${job.id}`;
  const verdict =
    job.status === 'exited'
      ? 'finished successfully (exit 0)'
      : job.status === 'failed'
        ? `exited with code ${job.exitCode}`
        : 'was killed before it could record an exit (likely terminated externally)';
  return (
    `⚙️ Background ${name} ${verdict}.\n\n` +
    `Command: ${job.command}\n\n` +
    `Last output:\n${tailLog(job.logPath)}\n\n` +
    `Re-check and continue, or conclude.`
  );
}

function renderCompletionToolInput(job: Job): Record<string, unknown> {
  return {
    jobId: job.id,
    label: job.label,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.exitCode,
  };
}

// ── Cancel / list ────────────────────────────────────────────────

/** Cancel a running job: signal its process group, then mark cancelled. */
export async function cancelJob(jobId: string, userId: string): Promise<boolean> {
  const job = (await getServices().jobs.getJob(jobId)) as Job | undefined;
  if (!job || job.userId !== userId) return false;
  if (job.pid != null) {
    // Negative pid → the whole process group (the detached session).
    try {
      process.kill(-job.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await getServices().jobs.updateJob(jobId, { status: 'cancelled' });
  emit(userId, 'job:cancelled', { ...job, status: 'cancelled' });
  log.info('Job cancelled', { namespace: NS, jobId });
  return true;
}

export function listJobsForUser(userId: string): Promise<Job[]> {
  return getServices().jobs.listJobsByUser(userId) as Promise<Job[]>;
}

export async function readJobLog(
  jobId: string,
  userId: string,
  offset = 0,
): Promise<JobLogChunk | null> {
  const job = (await getServices().jobs.getJob(jobId)) as Job | undefined;
  if (!job || job.userId !== userId) return null;

  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  let size = 0;
  let output = '';
  let nextOffset = safeOffset;

  try {
    const stats = await stat(job.logPath);
    size = stats.size;
    const readOffset = Math.min(safeOffset, size);
    const bytesToRead = Math.min(MAX_LOG_READ_BYTES, size - readOffset);

    if (bytesToRead > 0) {
      const handle = await open(job.logPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, readOffset);
        output = buffer.subarray(0, bytesRead).toString('utf8');
        nextOffset = readOffset + bytesRead;
      } finally {
        await handle.close();
      }
    } else {
      nextOffset = readOffset;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return {
    output,
    offset: Math.min(nextOffset, size),
    size,
    status: job.status,
    exitCode: job.exitCode,
  };
}

export async function removeThreadJobs(threadId: string): Promise<void> {
  await getServices().jobs.deleteJobsByThread(threadId);
}

// ── Lifecycle ────────────────────────────────────────────────────

/**
 * Start the job poller. Like the watcher scanner, this IS the rehydration:
 * running jobs live in the DB and their status is re-derived from the
 * exitfile/pid on the next scan — no in-memory handle to rebuild after restart.
 */
export function startAgentJobs(): void {
  if (scanner) return;
  scanner = setInterval(() => void scanOnce(), HEARTBEAT_MS);
  log.info('Agent job scanner started', { namespace: NS, heartbeatMs: HEARTBEAT_MS });
}

export function stopAgentJobs(): void {
  if (scanner) {
    clearInterval(scanner);
    scanner = null;
  }
}

shutdownManager.register('agent-job-manager', () => stopAgentJobs(), ShutdownPhase.SERVICES);
