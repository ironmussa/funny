/**
 * @domain subdomain: Agent Checks
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: CheckToolchain
 *
 * Runs a `CheckPlan` and follows it: each step's output goes, line by line,
 * through the shared parsers into a test-progress or task-progress run, which
 * is rewritten to `progressPath` as it advances (atomically, throttled) unless
 * the command writes that file itself (funny's own runners). The file always
 * ends in `passed` or `failed`, including when the run is cancelled or times
 * out: the process group is signalled and the run finalised as failed.
 *
 * It logs nothing itself: the background job's process (`run-cli.ts`) prints
 * only the summary, and callers log the result.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsync, sleep } from '@funny/shared/async';
import {
  createOutputParser,
  createStepParser,
  isEventLine,
  suiteFields,
} from '@funny/shared/checks';
import {
  openProgressFile,
  pumpLines,
  type ThrottledJsonFile,
} from '@funny/shared/checks/progress-file';
import { buildChildEnv } from '@funny/shared/lib/child-env';
import {
  parseTaskProgress,
  TASK_ISSUE_LIMIT,
  TASK_PROGRESS_VERSION,
  type TaskProgress,
} from '@funny/shared/task-progress';
import {
  parseTestProgress,
  TEST_PROGRESS_VERSION,
  type TestProgress,
} from '@funny/shared/test-progress';

import type { CheckPlan, CheckStep } from './toolchain.js';

/** The reporter `--reporter=` hands to a project's vitest; copied next to the bundle. */
export const VITEST_REPORTER = join(
  // `import.meta.dir` is Bun's; tests run under Node-compatible vitest.
  import.meta.dir ?? dirname(fileURLToPath(import.meta.url)),
  'vitest-progress-reporter.mjs',
);

const KILL_GRACE_MS = 3_000;
/** Output lines kept per step for the summary tail. */
const TAIL_LINES = 30;

export type CheckProgress =
  | { kind: 'test'; progress: TestProgress }
  | { kind: 'task'; progress: TaskProgress };

export interface CheckRunResult {
  exitCode: number;
  durationMs: number;
  /** How the run ended when it did not end on its own. */
  stopped?: 'cancelled' | 'timeout';
  progress: CheckProgress;
  /** Last output lines of the step that failed (or the last step). */
  tail: string[];
}

export interface RunCheckOptions {
  progressPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** The command with funny's vitest reporter added next to the default one. */
export function withVitestReporter(command: string): string {
  const flags = `--reporter=default --reporter=${VITEST_REPORTER}`;
  return /\s--\s/.test(command) || /^(npm|pnpm|yarn|bun) run /.test(command)
    ? `${command}${/\s--(\s|$)/.test(command) ? '' : ' --'} ${flags}`
    : `${command} ${flags}`;
}

interface StepOutcome {
  exitCode: number;
  tail: string[];
}

/** Kills the process group (the shell and everything it started). */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** Runs one step through `bash -c`, handing each output line to `onLine`. */
async function runStep(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<StepOutcome> {
  const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['bash', '-c'];
  const child = spawn(shell[0], [shell[1], command], {
    cwd,
    env: buildChildEnv({ ...env, CI: env.CI ?? '1', FORCE_COLOR: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const tail: string[] = [];
  const read = (line: string) => {
    onLine(line);
    if (!isEventLine(line) && line.trim()) tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    killGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const exited = new Promise<number>((resolve) => {
      child.on('error', (error) => {
        read(`failed to start: ${error.message}`);
        resolve(127);
      });
      child.on('close', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
    });
    const [exitCode] = await Promise.all([
      exited,
      pumpLines(child.stdout!, read),
      pumpLines(child.stderr!, read),
    ]);
    return { exitCode, tail };
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
  }
}

/** The run's in-memory progress, written to the file unless the command writes it. */
class RunProgress {
  /** Set by `close`: a step still winding down must not touch the run. */
  private closed = false;
  readonly file: ThrottledJsonFile<TestProgress | TaskProgress> | null;
  private readonly test: TestProgress | null;
  private readonly task: TaskProgress | null;

  constructor(plan: CheckPlan, path: string, now: () => number) {
    const startedAt = now();
    const head = { status: 'running' as const, startedAt, updatedAt: startedAt };
    this.test =
      plan.progress === 'test'
        ? {
            version: TEST_PROGRESS_VERSION,
            ...head,
            suites: plan.steps.map((step) => ({
              name: step.name,
              related: false,
              status: 'queued' as const,
              passed: 0,
              failed: 0,
              skipped: 0,
              running: [],
              slow: [],
              failures: [],
            })),
          }
        : null;
    this.task =
      plan.progress === 'task'
        ? {
            version: TASK_PROGRESS_VERSION,
            title: plan.kind,
            ...head,
            steps: plan.steps.map((step) => ({
              id: step.command,
              name: step.name,
              status: 'queued' as const,
              errors: 0,
              warnings: 0,
              tail: [],
            })),
            issues: [],
          }
        : null;
    const value = (this.test ?? this.task)!;
    this.file = plan.progressEnv
      ? null
      : openProgressFile<TestProgress | TaskProgress>(path, () => value, { now });
  }

  /** Feeds a step's output into its suite or step; returns the line handler. */
  follow(index: number, now: () => number): (line: string) => void {
    if (this.test) {
      const suite = this.test.suites[index];
      Object.assign(suite, { status: 'running', startedAt: now() });
      const parse = createOutputParser(now);
      return (line) => {
        if (this.closed) return;
        Object.assign(suite, suiteFields(parse(line)));
        this.file?.changed();
      };
    }
    const task = this.task!;
    const step = task.steps[index];
    Object.assign(step, { status: 'running', startedAt: now() });
    const parse = createStepParser(step.name);
    return (line) => {
      if (this.closed) return;
      const { report, issues } = parse(line);
      const { errors, warnings, unitsDone, unitsTotal, current } = report;
      Object.assign(step, { errors, warnings, unitsDone, unitsTotal, current });
      if (issues.length) {
        task.issues = [...task.issues, ...issues]
          .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
          .slice(0, TASK_ISSUE_LIMIT);
      }
      this.file?.changed();
    };
  }

  finishStep(index: number, outcome: StepOutcome, durationMs: number): void {
    if (this.closed) return;
    const status = outcome.exitCode === 0 ? 'passed' : 'failed';
    if (this.test) {
      Object.assign(this.test.suites[index], { status, durationMs, running: [] });
    } else {
      const step = this.task!.steps[index];
      const tail = status === 'failed' && step.errors === 0 ? outcome.tail.slice(-8) : [];
      Object.assign(step, { status, durationMs, tail });
    }
    this.file?.changed();
  }

  /** Marks the run finished; writes it now when this runner owns the file. */
  close(failed: boolean, now: number): CheckProgress {
    this.closed = true;
    const value = (this.test ?? this.task)!;
    Object.assign(value, { status: failed ? 'failed' : 'passed', finishedAt: now, updatedAt: now });
    this.file?.flush();
    return this.test
      ? { kind: 'test', progress: this.test }
      : { kind: 'task', progress: this.task! };
  }
}

/** The progress file a self-reporting command wrote, if it is valid. */
function readOwnProgress(plan: CheckPlan, path: string): CheckProgress | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (plan.progress === 'test') {
    const parsed = parseTestProgress(raw);
    return parsed.ok ? { kind: 'test', progress: parsed.value } : null;
  }
  const parsed = parseTaskProgress(raw);
  return parsed.ok ? { kind: 'task', progress: parsed.value } : null;
}

/**
 * A self-reporting command that was killed leaves its file `running`: end it
 * as failed so the widget stops following it.
 */
function finalizeOwnProgress(found: CheckProgress, path: string, at: number): void {
  if (found.progress.status !== 'running') return;
  Object.assign(found.progress, { status: 'failed', finishedAt: at, updatedAt: at });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(found.progress));
  renameSync(tmp, path);
}

function stepCommand(plan: CheckPlan, step: CheckStep): string {
  return plan.vitest && (step.tool === 'vitest' || step.tool === 'script')
    ? withVitestReporter(step.command)
    : step.command;
}

/** Runs the plan's steps in order (stopping at none: every step reports). */
async function runSteps(
  plan: CheckPlan,
  run: RunProgress,
  options: RunCheckOptions,
  signal: AbortSignal,
): Promise<{ exitCode: number; tail: string[] }> {
  const now = options.now ?? Date.now;
  const env = plan.progressEnv ? { [plan.progressEnv]: options.progressPath } : {};
  let exitCode = 0;
  let tail: string[] = [];
  for (const [index, step] of plan.steps.entries()) {
    if (signal.aborted) break;
    const started = now();
    const outcome = await runStep(
      stepCommand(plan, step),
      plan.cwd,
      env,
      signal,
      run.follow(index, now),
    );
    run.finishStep(index, outcome, now() - started);
    if (outcome.exitCode !== 0 || !tail.length) tail = outcome.tail;
    if (outcome.exitCode !== 0 && exitCode === 0) exitCode = outcome.exitCode;
  }
  return { exitCode, tail };
}

/**
 * Runs `plan` to the end, or until `signal` aborts or `timeoutMs` passes.
 * Never rejects: a failure to run is a failed result.
 */
export async function runCheck(plan: CheckPlan, options: RunCheckOptions): Promise<CheckRunResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const run = new RunProgress(plan, options.progressPath, now);
  let stopped: CheckRunResult['stopped'];
  let outcome = { exitCode: 1, tail: [] as string[] };
  let inflight: Promise<unknown> = Promise.resolve();
  try {
    outcome = await runAsync(
      (signal) => {
        const steps = runSteps(plan, run, options, signal);
        inflight = steps.catch(() => {});
        return steps;
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        timeoutError: () => new CheckTimeout(),
      },
    );
  } catch (error) {
    // The interrupted step's process group got SIGTERM (SIGKILL after the
    // grace): wait for it to exit so the file is final when this returns.
    await Promise.race([inflight, sleep(KILL_GRACE_MS + 500)]);
    stopped = error instanceof CheckTimeout ? 'timeout' : 'cancelled';
    outcome = {
      exitCode: 130,
      tail: [stopped === 'timeout' ? `timed out after ${options.timeoutMs} ms` : 'cancelled'],
    };
  }
  const failed = outcome.exitCode !== 0;
  const own = run.close(failed, now());
  const reported = plan.progressEnv ? readOwnProgress(plan, options.progressPath) : null;
  if (reported) finalizeOwnProgress(reported, options.progressPath, now());
  const progress = reported ?? own;
  return {
    exitCode: outcome.exitCode,
    durationMs: now() - started,
    ...(stopped ? { stopped } : {}),
    progress,
    tail: outcome.tail,
  };
}

class CheckTimeout extends Error {
  constructor() {
    super('check timed out');
  }
}
