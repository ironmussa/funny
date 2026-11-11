// Runs a task made of steps (see task-steps.ts) with live progress:
//
//   bun scripts/run-steps.ts lint | typecheck | build | verify
//
// The steps of a task run up to `FUNNY_TASK_CONCURRENCY` (default 4) at once,
// one at a time for a sequential task (build). Each step's output is printed in
// one block when it ends. With `FUNNY_TASK_PROGRESS` naming a file, progress is
// written there for the client's `task-progress` visualizer (`verify` also
// writes its test run to the same path with `.tests.json`, for `test-progress`).
// Exits non-zero when any step fails; every step still runs.

import { join } from 'node:path';

import { createStepParser, type StepReport } from '../packages/shared/src/checks';
import {
  TASK_ISSUE_LIMIT,
  TASK_PROGRESS_VERSION,
  type TaskIssue,
  type TaskProgress,
  type TaskStep,
} from '../packages/shared/src/task-progress';
import {
  collectOutput,
  openProgressFile,
  type ThrottledJsonFile,
  type ThrottleOptions,
} from './progress-io';
import { TASK_NAMES, taskFor, type TaskDef, type TaskStepDef } from './task-steps';
import { testSuiteEnv } from './test-env';

const ROOT = join(import.meta.dir, '..');
export const DEFAULT_STEP_CONCURRENCY = 4;

function queuedStep({ id, name }: TaskStepDef): TaskStep {
  return { id, name, status: 'queued', errors: 0, warnings: 0, tail: [] };
}

/** Keeps the progress file of a task run up to date. */
export class TaskProgressFile {
  private readonly file: ThrottledJsonFile<TaskProgress>;
  private readonly errors: TaskIssue[] = [];
  private readonly warnings: TaskIssue[] = [];

  constructor(
    path: string,
    task: TaskDef,
    options: ThrottleOptions & { concurrency?: number } = {},
  ) {
    this.file = openProgressFile<TaskProgress>(
      path,
      (head) => ({
        version: TASK_PROGRESS_VERSION,
        title: task.name,
        ...head,
        steps: task.steps.map(queuedStep),
        issues: [],
      }),
      options,
    );
  }

  start(index: number): void {
    this.patch(index, { status: 'running', startedAt: this.file.now() });
  }

  report(index: number, report: StepReport, issues: readonly TaskIssue[]): void {
    for (const issue of issues) {
      const list = issue.severity === 'error' ? this.errors : this.warnings;
      if (list.length < TASK_ISSUE_LIMIT) list.push(issue);
    }
    if (issues.length > 0) {
      this.file.value.issues = [...this.errors, ...this.warnings].slice(0, TASK_ISSUE_LIMIT);
    }
    this.patch(index, report);
  }

  finish(index: number, code: number, durationMs: number): void {
    const step = this.file.value.steps[index];
    // The tail only helps when the failure reported no issue of its own.
    const tail = code !== 0 && step.errors === 0 ? step.tail : [];
    this.patch(index, { status: code === 0 ? 'passed' : 'failed', durationMs, tail });
  }

  close(failed: boolean): void {
    this.file.value.status = failed ? 'failed' : 'passed';
    this.file.value.finishedAt = this.file.now();
    this.file.flush();
  }

  private patch(index: number, fields: Partial<TaskStep>): void {
    Object.assign(this.file.value.steps[index], fields);
    this.file.changed();
  }
}

interface StepResult {
  step: TaskStepDef;
  code: number;
  durationMs: number;
}

interface RunOptions {
  root?: string;
  concurrency?: number;
  progressPath?: string;
}

/** Runs one step through `sh -c`, handing each output line to `onLine`. */
async function runStep(
  step: TaskStepDef,
  root: string,
  {
    buffered,
    onLine,
    env,
  }: { buffered: boolean; onLine: (line: string) => void; env: Record<string, string> },
): Promise<StepResult> {
  const start = performance.now();
  console.log(buffered ? `▶ ${step.name}` : `\n=== ${step.name} ===`);
  const path = [join(root, 'node_modules', '.bin'), env.PATH].filter(Boolean).join(':');
  const proc = Bun.spawn(['sh', '-c', step.id], {
    cwd: root,
    env: { ...env, PATH: path },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const { code, durationMs } = await collectOutput(proc, {
    title: step.name,
    buffered,
    start,
    onLine,
  });
  return { step, code, durationMs };
}

/** Env for the steps: verify's test run writes its own progress next to the task's. */
function stepEnv(progressPath: string | undefined): Record<string, string> {
  const env = testSuiteEnv(process.env);
  if (progressPath) env.FUNNY_TEST_PROGRESS = progressPath.replace(/\.json$/, '') + '.tests.json';
  return env;
}

/** Runs `task`'s steps, prints a summary and resolves to the exit code. */
export async function runTask(
  task: TaskDef,
  { root = ROOT, concurrency = DEFAULT_STEP_CONCURRENCY, progressPath }: RunOptions = {},
): Promise<number> {
  const limit = task.sequential ? 1 : Math.max(1, Math.min(concurrency, task.steps.length));
  const buffered = limit > 1;
  const progress = progressPath
    ? new TaskProgressFile(progressPath, task, { concurrency: limit })
    : null;
  const env = stepEnv(progressPath);
  const results: StepResult[] = new Array(task.steps.length);
  let next = 0;
  const worker = async () => {
    while (next < task.steps.length) {
      const index = next++;
      const parse = createStepParser(task.steps[index].name);
      progress?.start(index);
      const onLine = (line: string) => {
        const { report, issues } = parse(line);
        progress?.report(index, report, issues);
      };
      const result = await runStep(task.steps[index], root, { buffered, onLine, env });
      progress?.finish(index, result.code, result.durationMs);
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));

  console.log(`\n=== ${task.name} summary ===`);
  for (const { step, code, durationMs } of results) {
    const status = code === 0 ? 'PASS' : `FAIL (${code})`;
    console.log(`${status.padEnd(10)} ${step.name} ${(durationMs / 1000).toFixed(1)}s`);
  }
  const failed = results.filter((result) => result.code !== 0).length;
  progress?.close(failed > 0);
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  const name = process.argv[2] ?? '';
  const scripts = (await Bun.file(join(ROOT, 'package.json')).json()).scripts ?? {};
  const task = taskFor(name, scripts);
  if (!task) {
    console.error(`usage: bun scripts/run-steps.ts <${TASK_NAMES.join('|')}>`);
    process.exit(2);
  }
  const concurrency = Number(process.env.FUNNY_TASK_CONCURRENCY) || DEFAULT_STEP_CONCURRENCY;
  process.exit(await runTask(task, { concurrency, progressPath: process.env.FUNNY_TASK_PROGRESS }));
}
