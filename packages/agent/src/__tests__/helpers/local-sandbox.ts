/**
 * A sandbox provider for the whole-factory tests, on `@funny/sandbox`'s
 * contract: each sandbox is a temp directory (its user's `$HOME`) where
 * `exec` runs commands with bash. Starting the step runner detached is the one
 * command it does not run with bash: the step runs in this process instead,
 * with the real step and a fake agent, in the environment its `step.env` gives.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

import type { CreateSandboxRequest, SandboxError, SandboxProvider } from '@funny/sandbox';
import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import { runStepInProcess, type InProcessStepOptions } from './in-process-step.js';

export interface LocalSandboxProvider extends SandboxProvider {
  /** Every create request, as the provider received it. */
  readonly creates: CreateSandboxRequest[];
  /** Every command run through `exec`. */
  readonly commands: string[];
  readonly sandboxes: Map<string, { dir: string; state: 'running' | 'stopped' }>;
  /** Make the next create fail with `error`. */
  failNextCreate(error: SandboxError): void;
}

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

export function localSandboxProvider(
  root: string,
  steps: InProcessStepOptions,
): LocalSandboxProvider {
  const creates: CreateSandboxRequest[] = [];
  const commands: string[] = [];
  const sandboxes = new Map<string, { dir: string; state: 'running' | 'stopped' }>();
  let nextCreateError: SandboxError | null = null;
  const id = 'local';

  const bash = (dir: string, command: string) => {
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

  type LocalSandbox = { dir: string; state: 'running' | 'stopped' };
  const sandbox = (sandboxId: string): ResultAsync<LocalSandbox, SandboxError> => {
    const found = sandboxes.get(sandboxId);
    return found ? okAsync(found) : errAsync({ kind: 'not-found', message: sandboxId });
  };

  return {
    id,
    creates,
    commands,
    sandboxes,
    failNextCreate(error) {
      nextCreateError = error;
    },
    capabilities: () => ({
      stopPreservesDisk: true,
      stoppedRetentionMs: null,
      maxLifetimeMs: null,
      sizes: [{ id: 'default', vcpu: 2, memoryGb: 4, default: true }],
      env: { maxVars: 100, maxBytes: 64 * 1024 },
      preStopHook: 'none',
    }),
    validate: () => okAsync({ accountLabel: 'local' }),
    resolveTemplate: (version) => okAsync({ providerId: id, ref: `funny-runner-${version}` }),
    create(request) {
      creates.push(request);
      if (nextCreateError) {
        const error = nextCreateError;
        nextCreateError = null;
        return errAsync(error);
      }
      const dir = mkdtempSync(join(root, 'sandbox-'));
      const sandboxId = dir.split('/').pop()!;
      sandboxes.set(sandboxId, { dir, state: 'running' });
      return okAsync({ providerId: id, sandboxId });
    },
    status: (handle) =>
      sandbox(handle.sandboxId).map((s) => ({ state: s.state, providerState: s.state })),
    stop: (handle) => sandbox(handle.sandboxId).map((s) => void (s.state = 'stopped')),
    resume: (handle) => sandbox(handle.sandboxId).map((s) => void (s.state = 'running')),
    extendLifetime: () => okAsync(undefined),
    destroy: (handle) => {
      const found = sandboxes.get(handle.sandboxId);
      if (found) rmSync(found.dir, { recursive: true, force: true });
      sandboxes.delete(handle.sandboxId);
      return okAsync(undefined);
    },
    exec(handle, command) {
      commands.push(command);
      return sandbox(handle.sandboxId).andThen((s) => {
        if (s.state !== 'running') {
          return errAsync<never, SandboxError>({ kind: 'unavailable', message: 'not running' });
        }
        const start = START_STEP.exec(command);
        if (!start) return okAsync(bash(s.dir, command));
        // The prefix (marker removed, spec written, cd) runs; the step runs here, detached.
        const prefix = bash(s.dir, start[1]);
        if (prefix.exitCode !== 0) return okAsync(prefix);
        const [, , work, step, specPath] = start;
        const cwd = /cd '([^']+)'\s*$/.exec(start[1])?.[1] ?? s.dir;
        const spec = JSON.parse(readFileSync(specPath, 'utf8'));
        void runStepInProcess(steps, {
          step: step as 'implement' | 'fix',
          spec,
          cwd,
          env: stepEnv(work, s.dir),
        });
        return okAsync({ exitCode: 0, stdout: '', stderr: '' });
      });
    },
  };
}
