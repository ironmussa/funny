/**
 * Factory steps the runner executes in a run's own checkout (openspec
 * factory-integration, D5-D7): a flow's `run_command`, and `integrate`, which
 * merges the base branch into the run's branch deterministically (weave and
 * rerere through the process environment, declared regenerators) before an
 * agent is ever asked to resolve a conflict.
 *
 * Never on the server: the server asks the thread's runner, which runs the step
 * where the thread's agent runs (its worktree, or its sandbox). One step at a
 * time per thread. Output is bounded and the values of the secrets in the
 * runner's environment are masked before it is recorded.
 */

import { randomUUID } from 'node:crypto';

import { execute, factoryGitConfigEnv, gitNetwork, gitRead, gitWrite } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { factoryGitDir } from './agent-startup/factory-git.js';
import {
  changeDelta,
  type ChangeDeltaRequest,
  type ChangeDeltaResult,
} from './factory-change-delta.js';

const ns = 'factory-steps';

/** Each stream keeps its last 64 KiB. */
export const OUTPUT_LIMIT = 64 * 1024;
/** A command may print a lot; only the tail is kept, but it must not be killed for it. */
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
/** How much of the base's diff a conflict result carries. */
const BASE_DIFF_LIMIT = 20_000;
/** Values shorter than this are not masked (they would mask ordinary words). */
const MIN_SECRET_LENGTH = 8;
/** Environment variables whose values are secrets. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|AUTH/i;

export interface Regenerator {
  /** Globs of the paths it regenerates. */
  paths: string[];
  /** The command that regenerates them, run from the checkout's root. */
  run: string;
  timeoutMs: number;
}

export type FactoryStepRequest =
  | { kind: 'command'; command: string; timeoutMs: number }
  | {
      kind: 'integrate';
      /** The base branch to merge in (`origin/<baseBranch>`). */
      baseBranch: string;
      /** The run's branch, pushed after a merge. */
      branch: string;
      regenerators: Regenerator[];
      /** Fast checks run after a merge, before it is pushed. */
      checks: string[];
      timeoutMs: number;
    }
  | ChangeDeltaRequest;

export interface CommandResult {
  kind: 'command';
  outcome: 'passed' | 'failed' | 'timed-out' | 'stopped';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface IntegrateResult {
  kind: 'integrate';
  /**
   * `up-to-date`: the branch already contains the base. `merged`: the base was
   * merged in and pushed. `conflict`: conflicts remain and nothing was pushed.
   * `failed`: git, a regenerator or a check could not run.
   */
  outcome: 'up-to-date' | 'merged' | 'conflict' | 'failed';
  headBefore: string;
  headAfter: string;
  /** Paths changed on both sides that merged without a conflict left (weave, rerere or git). */
  resolvedPaths: string[];
  /** Paths a regenerator produced. */
  regeneratedPaths: string[];
  /** Paths still conflicted (on `conflict`). */
  conflictedPaths: string[];
  /**
   * On `conflict`: what the base changed in the conflicted paths since the
   * branch left it (the work that merged in between), at most 20,000 characters.
   */
  baseDiff: string;
  /** Whether weave was the merge driver. */
  weave: boolean;
  message: string;
}

export type FactoryStepResult = CommandResult | IntegrateResult | ChangeDeltaResult;

export interface FactoryStepJob {
  id: string;
  kind: FactoryStepRequest['kind'];
  state: 'running' | 'done';
  result?: FactoryStepResult;
  controller: AbortController;
}

// ── Output ────────────────────────────────────────────────────

/** The secret values in `env`, longest first, so a value inside another is masked whole. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && (value?.length ?? 0) >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

/** The output as recorded: secret values masked, then the last `OUTPUT_LIMIT` characters. */
export function recordedOutput(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) masked = masked.split(secret).join('[masked]');
  return masked.length > OUTPUT_LIMIT ? masked.slice(-OUTPUT_LIMIT) : masked;
}

// ── run_command ───────────────────────────────────────────────

async function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  env: Record<string, string>,
) {
  const started = Date.now();
  try {
    const result = await execute('sh', ['-c', command], {
      cwd,
      signal,
      env,
      timeout: timeoutMs,
      reject: false,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      skipPool: true,
    });
    return {
      outcome: result.exitCode === 0 ? ('passed' as const) : ('failed' as const),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: signal.aborted ? ('stopped' as const) : ('timed-out' as const),
      exitCode: null,
      stdout: '',
      stderr: message,
      durationMs: Date.now() - started,
    };
  }
}

async function runCommandStep(
  cwd: string,
  request: Extract<FactoryStepRequest, { kind: 'command' }>,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<CommandResult> {
  const run = await runShell(request.command, cwd, signal, request.timeoutMs, env);
  const secrets = secretValues(process.env);
  return {
    kind: 'command',
    ...run,
    stdout: recordedOutput(run.stdout, secrets),
    stderr: recordedOutput(run.stderr, secrets),
  };
}

// ── integrate ─────────────────────────────────────────────────

/** Whether `path` matches the glob (`**` spans directories, `*` stays in one, `?` one character). */
export function matchesGlob(path: string, glob: string): boolean {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') pattern += '[^/]*';
    else if (ch === '?') pattern += '[^/]';
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`).test(path);
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

async function headOf(cwd: string): Promise<string> {
  const head = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false });
  return head.stdout.trim();
}

async function conflictedPaths(cwd: string, env: Record<string, string>): Promise<string[]> {
  const out = await gitRead(['diff', '--name-only', '--diff-filter=U'], {
    cwd,
    env,
    reject: false,
  });
  return lines(out.stdout);
}

/** Paths both the branch and the base changed since they split: where a merge had work to do. */
async function bothChanged(cwd: string, base: string): Promise<string[]> {
  const mergeBase = await gitRead(['merge-base', 'HEAD', base], { cwd, reject: false });
  const fork = mergeBase.stdout.trim();
  if (!fork) return [];
  const [ours, theirs] = await Promise.all([
    gitRead(['diff', '--name-only', fork, 'HEAD'], { cwd, reject: false }),
    gitRead(['diff', '--name-only', fork, base], { cwd, reject: false }),
  ]);
  const theirSet = new Set(lines(theirs.stdout));
  return lines(ours.stdout).filter((path) => theirSet.has(path));
}

/** Run every regenerator whose globs match a conflicted path; the paths they produced. */
async function regenerate(
  cwd: string,
  conflicted: string[],
  regenerators: Regenerator[],
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<{ paths: string[] } | { error: string }> {
  const produced: string[] = [];
  for (const regenerator of regenerators) {
    const paths = conflicted.filter((path) => regenerator.paths.some((g) => matchesGlob(path, g)));
    if (paths.length === 0) continue;
    // Take the base's side, then let the command produce the file from the merged sources.
    await gitWrite(['checkout', '--theirs', '--', ...paths], { cwd, env, reject: false });
    const run = await runShell(regenerator.run, cwd, signal, regenerator.timeoutMs, env);
    if (run.outcome !== 'passed') {
      return {
        error: `The regenerator \`${regenerator.run}\` ${run.outcome}: ${run.stderr.slice(-2000)}`,
      };
    }
    await gitWrite(['add', '--', ...paths], { cwd, env, reject: false });
    produced.push(...paths);
  }
  return { paths: produced };
}

async function runChecks(
  cwd: string,
  checks: string[],
  signal: AbortSignal,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<string | null> {
  for (const check of checks) {
    const run = await runShell(check, cwd, signal, timeoutMs, env);
    if (run.outcome !== 'passed') {
      const tail = recordedOutput(`${run.stdout}\n${run.stderr}`, secretValues(process.env));
      return `The integration check \`${check}\` ${run.outcome}:\n${tail.slice(-4000)}`;
    }
  }
  return null;
}

type IntegrateRequest = Extract<FactoryStepRequest, { kind: 'integrate' }>;

/** How the merge of the base went: settled (with what was regenerated), conflicted, or failed. */
type MergeOutcome =
  | { kind: 'settled'; regenerated: string[] }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'failed'; message: string };

/**
 * Merge `base` in (never a rebase: no force push, and the reviewed commit stays
 * in the history), regenerate the declared paths, and abort on what is left.
 * Without the repository's hooks: `git merge` runs `pre-merge-commit` and
 * `commit-msg`, and a hook that refuses "Merge … into …" (conventional commits)
 * would stop the merge; an integration's checks are the ones `integrate` declares.
 */
async function mergeBase(
  cwd: string,
  request: IntegrateRequest,
  base: string,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<MergeOutcome> {
  const message = `Merge ${base} into ${request.branch}`;
  await gitWrite(['merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, base], {
    cwd,
    env,
    reject: false,
  });
  const conflicted = await conflictedPaths(cwd, env);
  if (conflicted.length === 0) return { kind: 'settled', regenerated: [] };
  const produced = await regenerate(cwd, conflicted, request.regenerators, signal, env);
  const left = 'error' in produced ? [] : await conflictedPaths(cwd, env);
  if ('error' in produced || left.length > 0) {
    await gitWrite(['merge', '--abort'], { cwd, env, reject: false });
  }
  if ('error' in produced) return { kind: 'failed', message: produced.error };
  if (left.length > 0) return { kind: 'conflict', paths: left };
  return { kind: 'settled', regenerated: produced.paths };
}

/**
 * Commit a merge left open (it needed regenerated files); the error, or null.
 * Without the repository's pre-commit hooks, as `git merge` does when it
 * commits by itself: the same integration must not succeed or fail on whether
 * a file was regenerated, and its checks are the ones `integrate` declares.
 */
async function commitOpenMerge(cwd: string, env: Record<string, string>): Promise<string | null> {
  const open = await gitRead(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, reject: false });
  if (open.exitCode !== 0) return null;
  const committed = await gitWrite(['commit', '--no-edit', '--no-verify'], {
    cwd,
    env,
    reject: false,
  });
  if (committed.exitCode === 0) return null;
  await gitWrite(['merge', '--abort'], { cwd, env, reject: false });
  return `Could not commit the merge: ${committed.stderr.trim()}`;
}

/** Run the integration checks and push; on failure the branch goes back to `headBefore`. */
async function checkAndPush(
  cwd: string,
  request: IntegrateRequest,
  headBefore: string,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<string | null> {
  let failure = await runChecks(cwd, request.checks, signal, request.timeoutMs, env);
  if (!failure) {
    // --no-verify like the merge and commit above: the repository's pre-push
    // hook repeats what implement's push, regression-proof and CI check, and on
    // a merge that brings the base in it outlasts the push's timeout.
    const pushed = await gitNetwork(['push', '--no-verify', 'origin', `HEAD:${request.branch}`], {
      cwd,
      env,
      reject: false,
    });
    if (pushed.exitCode !== 0)
      failure = `Could not push ${request.branch}: ${pushed.stderr.trim()}`;
  }
  if (failure) await gitWrite(['reset', '--hard', headBefore], { cwd, env, reject: false });
  return failure;
}

/**
 * Bring the checkout up to the run's branch on origin; the error, or null.
 * The branch can move without this checkout: GitHub's update-branch (the merge
 * lane) or a push from elsewhere. Merging the base on the stale head would make
 * a commit that does not contain the branch's tip, and its push is refused as
 * non-fast-forward (found on issue #458). A branch not on origin yet is left
 * alone; one that diverged from it is refused, never overwritten.
 */
async function followRemoteBranch(
  cwd: string,
  request: IntegrateRequest,
  env: Record<string, string>,
): Promise<string | null> {
  const remote = `refs/remotes/origin/${request.branch}`;
  const fetched = await gitNetwork(['fetch', 'origin', `+refs/heads/${request.branch}:${remote}`], {
    cwd,
    env,
    reject: false,
  });
  if (fetched.exitCode !== 0) {
    if (/couldn't find remote ref/i.test(fetched.stderr)) return null;
    return `Could not fetch ${request.branch}: ${fetched.stderr.trim()}`;
  }
  const behind = await gitRead(['merge-base', '--is-ancestor', remote, 'HEAD'], {
    cwd,
    reject: false,
  });
  if (behind.exitCode === 0) return null;
  const forward = await gitRead(['merge-base', '--is-ancestor', 'HEAD', remote], {
    cwd,
    reject: false,
  });
  if (forward.exitCode !== 0) {
    return `The checkout and origin/${request.branch} have diverged: the branch moved on GitHub while this checkout has commits it does not.`;
  }
  const moved = await gitWrite(['merge', '--ff-only', '--no-verify', remote], {
    cwd,
    env,
    reject: false,
  });
  if (moved.exitCode !== 0) {
    return `Could not fast-forward to origin/${request.branch}: ${moved.stderr.trim()}`;
  }
  return null;
}

/** What the base changed in `paths` since the branch left it (three dots: the base's side only). */
async function baseDiffOf(cwd: string, base: string, paths: string[]): Promise<string> {
  const diff = await gitRead(['diff', `HEAD...${base}`, '--', ...paths], { cwd, reject: false });
  return diff.exitCode === 0 ? diff.stdout.slice(0, BASE_DIFF_LIMIT) : '';
}

async function integrateStep(
  cwd: string,
  request: IntegrateRequest,
  signal: AbortSignal,
  gitEnv: { env: Record<string, string>; weave: boolean },
): Promise<IntegrateResult> {
  const env = gitEnv.env;
  const base = `origin/${request.baseBranch}`;
  const followed = await followRemoteBranch(cwd, request, env);
  // After following origin: the head the review judged is the branch's tip there.
  const headBefore = await headOf(cwd);
  const result = (over: Partial<IntegrateResult> & Pick<IntegrateResult, 'outcome' | 'message'>) =>
    ({
      kind: 'integrate',
      headBefore,
      headAfter: headBefore,
      resolvedPaths: [],
      regeneratedPaths: [],
      conflictedPaths: [],
      baseDiff: '',
      weave: gitEnv.weave,
      ...over,
    }) satisfies IntegrateResult;
  if (followed) return result({ outcome: 'failed', message: followed });

  const fetched = await gitNetwork(['fetch', 'origin', request.baseBranch], {
    cwd,
    env,
    reject: false,
  });
  if (fetched.exitCode !== 0) {
    return result({
      outcome: 'failed',
      message: `Could not fetch ${base}: ${fetched.stderr.trim()}`,
    });
  }
  const contains = await gitRead(['merge-base', '--is-ancestor', base, 'HEAD'], {
    cwd,
    reject: false,
  });
  if (contains.exitCode === 0) {
    return result({ outcome: 'up-to-date', message: `The branch already contains ${base}.` });
  }

  const touched = await bothChanged(cwd, base);
  const merged = await mergeBase(cwd, request, base, signal, env);
  if (merged.kind === 'failed') return result({ outcome: 'failed', message: merged.message });
  if (merged.kind === 'conflict') {
    return result({
      outcome: 'conflict',
      conflictedPaths: merged.paths,
      baseDiff: await baseDiffOf(cwd, base, merged.paths),
      message: `Merging ${base} left conflicts in: ${merged.paths.join(', ')}`,
    });
  }
  const failure =
    (await commitOpenMerge(cwd, env)) ??
    (await checkAndPush(cwd, request, headBefore, signal, env));
  if (failure) return result({ outcome: 'failed', message: failure });
  const regenerated = new Set(merged.regenerated);
  return result({
    outcome: 'merged',
    headAfter: await headOf(cwd),
    resolvedPaths: touched.filter((path) => !regenerated.has(path)),
    regeneratedPaths: merged.regenerated,
    message: `Merged ${base} into ${request.branch}.`,
  });
}

// ── Jobs ──────────────────────────────────────────────────────

const jobs = new Map<string, FactoryStepJob>();

async function runStep(
  cwd: string,
  request: FactoryStepRequest,
  signal: AbortSignal,
): Promise<FactoryStepResult> {
  const gitEnv = await factoryGitConfigEnv(factoryGitDir()).unwrapOr({ env: {}, weave: false });
  if (request.kind === 'command') return runCommandStep(cwd, request, signal, gitEnv.env);
  if (request.kind === 'change-delta') return changeDeltaStep(cwd, request, signal, gitEnv.env);
  return integrateStep(cwd, request, signal, gitEnv);
}

const NO_DELTA = {
  ancestor: false,
  lines: 0,
  files: [],
  filesTruncated: false,
  outsideFrom: [],
} satisfies Partial<ChangeDeltaResult>;

/** `change-delta`: how the pull request's change differs at two commits; reads only. */
async function changeDeltaStep(
  cwd: string,
  request: ChangeDeltaRequest,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<ChangeDeltaResult> {
  const delta = await changeDelta(cwd, request, signal, env);
  if (delta.isErr()) {
    return { kind: 'change-delta', outcome: 'failed', ...NO_DELTA, message: delta.error };
  }
  return { kind: 'change-delta', outcome: 'compared', ...delta.value, message: '' };
}

function failedResult(request: FactoryStepRequest, message: string): FactoryStepResult {
  if (request.kind === 'change-delta') {
    return { kind: 'change-delta', outcome: 'failed', ...NO_DELTA, message };
  }
  if (request.kind === 'command') {
    return {
      kind: 'command',
      outcome: 'failed',
      exitCode: null,
      stdout: '',
      stderr: message,
      durationMs: 0,
    };
  }
  return {
    kind: 'integrate',
    outcome: 'failed',
    headBefore: '',
    headAfter: '',
    resolvedPaths: [],
    regeneratedPaths: [],
    conflictedPaths: [],
    baseDiff: '',
    weave: false,
    message,
  };
}

/** Start a step in `cwd`, the thread's checkout; a running step of the thread is stopped first. */
export function startFactoryStep(
  threadId: string,
  cwd: string,
  request: FactoryStepRequest,
): FactoryStepJob {
  jobs.get(threadId)?.controller.abort();
  const controller = new AbortController();
  const job: FactoryStepJob = {
    id: randomUUID(),
    kind: request.kind,
    state: 'running',
    controller,
  };
  jobs.set(threadId, job);
  runStep(cwd, request, controller.signal)
    .then((result) => {
      job.result = result;
      job.state = 'done';
      log.info('Factory step completed', {
        namespace: ns,
        threadId,
        kind: request.kind,
        outcome: result.outcome,
      });
    })
    .catch((error) => {
      job.result = failedResult(request, `The step could not run: ${String(error)}`);
      job.state = 'done';
      log.error('Factory step failed', {
        namespace: ns,
        threadId,
        kind: request.kind,
        error: String(error),
      });
    });
  return job;
}

export function getFactoryStep(threadId: string, stepId: string): FactoryStepJob | null {
  const job = jobs.get(threadId);
  return job && job.id === stepId ? job : null;
}

/** Stop a running step (its process is killed); whether there was one. */
export function cancelFactoryStep(threadId: string, stepId: string): boolean {
  const job = getFactoryStep(threadId, stepId);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(threadId);
  return true;
}
