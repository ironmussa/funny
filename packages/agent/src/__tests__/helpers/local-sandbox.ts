/**
 * What `exec` does in the whole-factory tests' sandboxes, given to
 * `@funny/sandbox`'s fake provider (which keeps the sandboxes' states and
 * capability modes): each sandbox is a temp directory (its user's `$HOME`)
 * where commands run with bash. Starting the step runner detached is the one
 * command not run with bash: the step runs in this process instead, with the
 * real step and a fake agent, in the environment its `step.env` gives.
 */

import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

import type { ExecResult } from '@funny/sandbox';

import { runStepInProcess, type InProcessStepOptions } from './in-process-step.js';

const START_STEP =
  /^(.*) && \(setsid nohup '([^']+)\/bin\/run-step' (implement|fix) --spec '([^']+)' >/s;

/** The environment `step.env` gives a step (sourced by bash, as `run-step` does). */
function stepEnv(work: string, home: string): Record<string, string> {
  const out = Bun.spawnSync(['bash', '-c', `set -a; . '${work}/step.env'; env -0`], {
    env: { PATH: process.env.PATH ?? '', HOME: home },
  });
  const env: Record<string, string> = {};
  for (const entry of out.stdout.toString().split('\0')) {
    const at = entry.indexOf('=');
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  env.PATH = `${work}/bin:${process.env.PATH ?? ''}`;
  return env;
}

export interface SandboxExec {
  /** The fake provider's `exec` option. */
  exec(sandboxId: string, command: string): ExecResult;
  /** The directory (and `$HOME`) of a sandbox. */
  dirOf(sandboxId: string): string;
}

export function sandboxExec(root: string, steps: InProcessStepOptions): SandboxExec {
  const dirOf = (sandboxId: string) => {
    const dir = join(root, sandboxId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const bash = (dir: string, command: string): ExecResult => {
    const run = Bun.spawnSync(['bash', '-c', command], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: dir },
    });
    return {
      exitCode: run.exitCode ?? 1,
      stdout: run.stdout.toString(),
      stderr: run.stderr.toString(),
    };
  };
  return {
    dirOf,
    exec(sandboxId, command) {
      const dir = dirOf(sandboxId);
      const start = START_STEP.exec(command);
      if (!start) return bash(dir, command);
      // The prefix (marker removed, spec written, cd) runs; the step runs here, detached.
      const prefix = bash(dir, start[1]);
      if (prefix.exitCode !== 0) return prefix;
      const [, , work, step, specPath] = start;
      const cwd = /cd '([^']+)'\s*$/.exec(start[1])?.[1] ?? dir;
      void runStepInProcess(steps, {
        step: step as 'implement' | 'fix',
        spec: JSON.parse(readFileSync(specPath, 'utf8')),
        cwd,
        env: stepEnv(work, dir),
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}
