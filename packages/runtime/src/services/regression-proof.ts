/**
 * Regression proof service: runs the changed test files against the head
 * commit (they must pass, twice) and against the base commit (they must fail,
 * by an assertion) to prove a fix.
 *
 * Both phases run in temporary detached worktrees prepared the same way (the
 * flow's setup command, else the head's `.funny.json` `postCreate`, e.g. a
 * dependency install), so a difference between
 * them is the code's, not the checkout's. The head runs first: when it fails,
 * the environment or the fix is broken and the base says nothing. A base
 * failure counts only when it is an assertion: a timeout, a setup failure or a
 * test file that cannot load (a missing module, a syntax error) is
 * inconclusive and fails the proof. The whole proof shares one time budget.
 */

import { randomUUID } from 'node:crypto';

import {
  changedFilesBetween,
  copyFilesFromCommit,
  createTempWorktree,
  execute,
  gitNetwork,
  mergeBase,
  removeTempWorktree,
  sweepTempWorktrees,
} from '@funny/core/git';
import { readProjectConfig } from '@funny/core/ports';

import { log } from '../lib/logger.js';

const ns = 'regression-proof';

export type ProofVerdict = 'pass' | 'fail' | 'skipped';

export interface ProofRule {
  globs: string[];
  command: string;
  cwd?: string;
}

export interface ProofRequest {
  headSha: string;
  defaultBranch: string;
  rules: ProofRule[];
  supportGlobs: string[];
  /**
   * Run in each temporary worktree before the tests (e.g. `bun install
   * --frozen-lockfile`); when absent, the head's `.funny.json` `postCreate`.
   */
  setupCommand?: string;
  /** The budget of the whole proof: setup and every test run, both phases. */
  timeoutMs: number;
}

/**
 * Why a proof failed: `test` when the agent can fix it (the tests fail on the
 * head, do not catch the bug, or do not fail by an assertion on the base),
 * `environment` when it cannot (setup, git, time, a stop).
 */
export type ProofFailureKind = 'test' | 'environment';

export interface ProofResult {
  verdict: ProofVerdict;
  /** Set on a `fail`. */
  failureKind?: ProofFailureKind;
  /** The commit the proof ran against. */
  headSha: string;
  finding?: string;
  files: string[];
  commands: string[];
  baseSha: string;
  /** A pass keeps the base's failing output (the evidence); a fail, the failing run's. */
  outputTail: string;
}

export type ProofJobState = 'running' | 'done';

export interface ProofJob {
  id: string;
  headSha: string;
  state: ProofJobState;
  result?: ProofResult;
  controller: AbortController;
}

const DEFAULT_SUPPORT_GLOBS = [
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/test-utils/**',
  '**/testing/**',
];

/** How many times the head runs: a test that passes once and fails once is flaky. */
const HEAD_RUNS = 2;
/** Test runners print a lot; only the tail is kept, but the run must not be killed for it. */
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const OUTPUT_TAIL = 4000;

/**
 * Output of a test file that never ran its assertions: it could not load.
 * Such a base failure proves nothing about the bug.
 */
const LOAD_ERROR =
  /Cannot find module|Cannot find package|Module not found|ERR_MODULE_NOT_FOUND|Could not resolve|SyntaxError|ReferenceError: .* is not defined|error: .*not found/i;

/**
 * Whether `file` matches the glob `pattern`: `**` spans directories (`**\/`
 * also matches none, so `**\/*.test.ts` matches a root file), `*` stays inside
 * one, `?` is one character.
 */
export function matchesGlob(file: string, pattern: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(file);
}

function matchesAnyGlob(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(file, p));
}

function assignFilesToRules(files: string[], rules: ProofRule[]): Map<ProofRule, string[]> {
  const assignments = new Map<ProofRule, string[]>();
  for (const rule of rules) assignments.set(rule, []);
  for (const file of files) {
    const rule = rules.find((r) => matchesAnyGlob(file, r.globs));
    if (rule) assignments.get(rule)!.push(file);
  }
  return assignments;
}

/** The files, relative to the rule's `cwd`, each single-quoted for `sh`. */
function shellQuote(files: string[], cwd?: string): string {
  const prefix = cwd ? `${cwd.replace(/\/+$/, '')}/` : '';
  return files
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f))
    .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
    .join(' ');
}

/**
 * The rule's command with every `{{files}}` replaced by the quoted files,
 * literally: a `$&` or `$'` in a file name is not a replacement pattern.
 */
export function fillCommand(command: string, files: string[], cwd?: string): string {
  return command.split('{{files}}').join(shellQuote(files, cwd));
}

export type RunOutcome =
  | { kind: 'exited'; exitCode: number; output: string }
  | { kind: 'timed-out'; output: string }
  | { kind: 'aborted'; output: string };

async function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RunOutcome> {
  if (timeoutMs <= 0) return { kind: 'timed-out', output: '' };
  try {
    const result = await execute('sh', ['-c', command], {
      cwd,
      signal,
      timeout: timeoutMs,
      reject: false,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      // A test run takes minutes: it must not hold a slot git commands need.
      skipPool: true,
    });
    return {
      kind: 'exited',
      exitCode: result.exitCode,
      output: `${result.stdout}\n${result.stderr}`.slice(-OUTPUT_TAIL),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted) return { kind: 'aborted', output: message };
    return { kind: 'timed-out', output: message };
  }
}

/**
 * Why a base failure does not prove the test catches the bug, or null when it
 * does (a test that ran and failed an assertion).
 */
export function inconclusiveBaseFailure(outcome: RunOutcome): string | null {
  if (outcome.kind === 'timed-out') return 'it timed out';
  if (outcome.kind === 'aborted') return 'it was stopped';
  if (outcome.exitCode === 0) return null;
  if (LOAD_ERROR.test(outcome.output))
    return 'a test file could not load (missing module or syntax error)';
  return null;
}

/** One phase's checkout: a temporary worktree at `sha`, prepared with the setup command. */
interface Checkout {
  path: string;
}

class ProofRun {
  private readonly deadline: number;
  readonly tempWorktrees: string[] = [];
  /** Resolved on the first (head) checkout, then reused for the base. */
  private setupCommands: string[] | null = null;

  constructor(
    readonly projectPath: string,
    readonly request: ProofRequest,
    readonly signal: AbortSignal,
  ) {
    this.deadline = Date.now() + request.timeoutMs;
  }

  remaining(): number {
    return this.deadline - Date.now();
  }

  /** A temporary worktree at `sha`, with `files` copied from the head and the setup run. */
  async checkout(
    sha: string,
    label: string,
    files: string[],
  ): Promise<{ ok: true; checkout: Checkout } | { ok: false; finding: string; output: string }> {
    const created = await createTempWorktree(this.projectPath, sha, label);
    if (created.isErr()) {
      return {
        ok: false,
        finding: `Setup failed on the ${label}: ${created.error.message}`,
        output: '',
      };
    }
    this.tempWorktrees.push(created.value);
    if (files.length > 0) {
      const copied = await copyFilesFromCommit(
        this.projectPath,
        created.value,
        this.request.headSha,
        files,
      );
      if (copied.isErr()) {
        return { ok: false, finding: `Copy failed: ${copied.error.message}`, output: '' };
      }
    }
    // The head's setup prepares both phases alike: the flow's `setup_command`,
    // else the head checkout's `.funny.json` `postCreate` (as a thread worktree).
    this.setupCommands ??= this.request.setupCommand
      ? [this.request.setupCommand]
      : (readProjectConfig(created.value)?.postCreate ?? []);
    for (const command of this.setupCommands) {
      const setup = await runCommand(command, created.value, this.signal, this.remaining());
      if (setup.kind !== 'exited' || setup.exitCode !== 0) {
        return {
          ok: false,
          finding: `Setup failed on the ${label}: \`${command}\` ${setup.kind === 'exited' ? `exited ${setup.exitCode}` : setup.kind}`,
          output: setup.output,
        };
      }
    }
    return { ok: true, checkout: { path: created.value } };
  }

  run(command: string, checkout: Checkout, cwd?: string): Promise<RunOutcome> {
    const dir = cwd ? `${checkout.path}/${cwd}` : checkout.path;
    return runCommand(command, dir, this.signal, this.remaining());
  }

  async cleanup(): Promise<void> {
    for (const wt of this.tempWorktrees) {
      await removeTempWorktree(this.projectPath, wt).match(
        () => {},
        () => {},
      );
    }
  }
}

export async function runProof(
  projectPath: string,
  request: ProofRequest,
  signal: AbortSignal,
): Promise<ProofResult> {
  const run = new ProofRun(projectPath, request, signal);
  try {
    const result = await proveCommit(run);
    return { ...result, headSha: request.headSha };
  } finally {
    await run.cleanup();
  }
}

async function proveCommit(run: ProofRun): Promise<Omit<ProofResult, 'headSha'>> {
  const { projectPath, request } = run;
  const { headSha, defaultBranch, rules } = request;
  const supportGlobs =
    request.supportGlobs.length > 0 ? request.supportGlobs : DEFAULT_SUPPORT_GLOBS;
  const failed = (
    finding: string,
    rest: Partial<Omit<ProofResult, 'headSha' | 'verdict'>> = {},
  ): Omit<ProofResult, 'headSha'> => ({
    verdict: 'fail',
    failureKind: 'environment',
    finding,
    files: [],
    commands: [],
    baseSha: '',
    outputTail: '',
    ...rest,
  });

  await gitNetwork(['fetch', 'origin', defaultBranch], {
    cwd: projectPath,
    reject: false,
    timeout: 60_000,
  });

  const baseResult = await mergeBase(projectPath, `origin/${defaultBranch}`, headSha);
  if (baseResult.isErr()) {
    return failed(`Could not compute merge-base: ${baseResult.error.message}`);
  }
  const baseSha = baseResult.value;

  const changedResult = await changedFilesBetween(projectPath, baseSha, headSha);
  if (changedResult.isErr()) {
    return failed(`Could not list changed files: ${changedResult.error.message}`, { baseSha });
  }

  const activeRules = [...assignFilesToRules(changedResult.value, rules)].flatMap(
    ([rule, files]) =>
      files.length > 0
        ? [{ rule, files, command: fillCommand(rule.command, files, rule.cwd) }]
        : [],
  );
  const testFiles = activeRules.flatMap(({ files }) => files);
  if (testFiles.length === 0) {
    return {
      verdict: 'skipped',
      finding: 'No test files changed',
      files: [],
      commands: [],
      baseSha,
      outputTail: '',
    };
  }
  const commands = activeRules.map(({ command }) => command);
  const context = { files: testFiles, commands, baseSha };

  // --- Head: must pass, every run ---
  const head = await run.checkout(headSha, 'head', []);
  if (!head.ok) return failed(head.finding, { ...context, outputTail: head.output });
  let headOutput = '';
  for (let attempt = 1; attempt <= HEAD_RUNS; attempt++) {
    for (const { rule, command } of activeRules) {
      const outcome = await run.run(command, head.checkout, rule.cwd);
      headOutput = outcome.output;
      if (outcome.kind === 'aborted') return failed('Aborted', context);
      if (outcome.kind === 'timed-out') {
        return failed('The proof ran out of time on the head commit', {
          ...context,
          outputTail: headOutput,
        });
      }
      if (outcome.exitCode !== 0) {
        return failed(
          attempt === 1
            ? 'Tests fail on the head commit'
            : `Tests passed on the head commit, then failed on run ${attempt}: they are flaky`,
          { ...context, outputTail: headOutput, failureKind: 'test' },
        );
      }
    }
  }

  // --- Base: the head's tests (and their support files) must fail by an assertion ---
  const supportFiles = changedResult.value.filter(
    (f) => !testFiles.includes(f) && matchesAnyGlob(f, supportGlobs),
  );
  const base = await run.checkout(baseSha, 'base', [...testFiles, ...supportFiles]);
  if (!base.ok) {
    return failed(`Inconclusive: ${base.finding}`, { ...context, outputTail: base.output });
  }
  let caught = false;
  let inconclusive: string | null = null;
  let baseOutput = '';
  for (const { rule, command } of activeRules) {
    const outcome = await run.run(command, base.checkout, rule.cwd);
    baseOutput += outcome.output;
    if (outcome.kind === 'aborted') return failed('Aborted', context);
    const why = inconclusiveBaseFailure(outcome);
    if (why) inconclusive ??= why;
    else if (outcome.kind === 'exited' && outcome.exitCode !== 0) caught = true;
  }
  const baseTail = baseOutput.slice(-OUTPUT_TAIL);
  if (caught) {
    // The evidence of a pass is the base failing: keep that output, not the head's.
    return { verdict: 'pass', ...context, outputTail: baseTail };
  }
  if (inconclusive) {
    return failed(
      `Inconclusive: the tests failed on the base commit, but not by an assertion (${inconclusive})`,
      { ...context, outputTail: baseTail, failureKind: 'test' },
    );
  }
  return failed('The tests pass on the base commit: they do not catch the bug', {
    ...context,
    outputTail: baseTail,
    failureKind: 'test',
  });
}

// ── Job registry ──────────────────────────────────────────────

const jobs = new Map<string, ProofJob>();

export function startProofJob(
  threadId: string,
  projectPath: string,
  request: ProofRequest,
): ProofJob {
  const existing = jobs.get(threadId);
  if (existing) {
    // Join a proof of the same commit that is still running; a finished one is
    // never reused, so a retry always runs again.
    if (existing.state === 'running' && existing.headSha === request.headSha) {
      return existing;
    }
    existing.controller.abort();
    jobs.delete(threadId);
  }

  const controller = new AbortController();
  const job: ProofJob = {
    id: randomUUID(),
    headSha: request.headSha,
    state: 'running',
    controller,
  };
  jobs.set(threadId, job);

  runProof(projectPath, request, controller.signal)
    .then((result) => {
      job.result = result;
      job.state = 'done';
      log.info('Regression proof completed', { namespace: ns, threadId, verdict: result.verdict });
    })
    .catch((err) => {
      job.result = {
        verdict: 'fail',
        failureKind: 'environment',
        headSha: request.headSha,
        finding: `Proof error: ${err instanceof Error ? err.message : String(err)}`,
        files: [],
        commands: [],
        baseSha: '',
        outputTail: '',
      };
      job.state = 'done';
      log.error('Regression proof failed', { namespace: ns, threadId, error: String(err) });
    });

  return job;
}

export function getProofJob(threadId: string, proofId: string): ProofJob | null {
  const job = jobs.get(threadId);
  if (!job || job.id !== proofId) return null;
  return job;
}

/** Stop a running proof (its test processes are killed); whether there was one. */
export function cancelProofJob(threadId: string, proofId: string): boolean {
  const job = getProofJob(threadId, proofId);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(threadId);
  log.info('Regression proof cancelled', { namespace: ns, threadId, proofId });
  return true;
}

export async function sweepProofWorktrees(projectPath: string): Promise<number> {
  const result = await sweepTempWorktrees(projectPath);
  return result.match(
    (n) => n,
    () => 0,
  );
}
