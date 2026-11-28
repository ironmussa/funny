/**
 * Factory flow setup verification job (openspec factory-flow-bootstrap, D4 / Task 3.3).
 *
 * Verifies every generated `regression_proof` rule in a clean temporary worktree
 * checked out at the setup's `baseSha` — never in the agent's worktree, so any
 * other edits the agent made (e.g. to `jest.config.ts`) are absent.
 *
 * Only the agent's canary files are copied into the clean worktree. After
 * running `setup_command` (or `.funny.json`'s `postCreate`), each rule must pass
 * four checks:
 *   1. Passing canary exits 0 and output names it.
 *   2. Failing canary exits non-zero, `inconclusiveBaseFailure` is null, and output names it.
 *   3. An existing repository test file matched by the rule (and not flagged as
 *      needing infrastructure) exits 0 (up to 3 candidates tried; 0 matches rejects).
 *   4. A two-file run (passing canary + that matched existing file) exits 0 and
 *      output names both files.
 *
 * Rejected rules are pruned from `workflowYaml` while preserving comments and
 * formatting. The whole job shares one 30-minute time budget and is abortable.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  createTempWorktree,
  gitRead,
  removeTempWorktree,
  sweepTempWorktrees,
} from '@funny/core/git';
import { readProjectConfig } from '@funny/core/ports';
import { pruneRegressionProofRules } from '@funny/workflows';

import { log } from '../lib/logger.js';
import {
  fillCommand,
  inconclusiveBaseFailure,
  matchesGlob,
  runShellCommand,
  type ProofRule,
  type RunOutcome,
} from './regression-proof.js';

const ns = 'factory-flow-setup-verify';

const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL = 4000;
const MAX_EXISTING_CANDIDATES = 3;

const DEFAULT_SUPPORT_GLOBS = [
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/test-utils/**',
  '**/testing/**',
];

export interface SetupCanarySpec {
  ruleIndex: number;
  passingPath: string;
  failingPath: string;
  /** Optional inline content (for tests); otherwise read from `agentWorktreePath`. */
  passingContent?: string;
  failingContent?: string;
}

export interface VerifyFlowSetupRequest {
  baseSha: string;
  workflowYaml: string;
  rules: ProofRule[];
  setupCommand?: string;
  supportGlobs?: string[];
  canaries: SetupCanarySpec[];
  /** Relative paths flagged by `detectTestStack` as needing infrastructure. */
  infraFiles?: string[];
  /** Agent worktree from which canary file contents are read when not provided inline. */
  agentWorktreePath?: string;
  /** Total verification budget in milliseconds (defaults to 30 minutes). */
  timeoutMs?: number;
}

export interface RuleCheckRun {
  command: string;
  files: string[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  outputTail: string;
}

export interface RuleVerificationVerdict {
  ruleIndex: number;
  globs: string[];
  command: string;
  cwd?: string;
  accepted: boolean;
  reason?: string;
  passingRun?: RuleCheckRun;
  failingRun?: RuleCheckRun;
  existingRun?: RuleCheckRun;
  twoFileRun?: RuleCheckRun;
}

export type VerifyFlowSetupFailureReason =
  | 'setup-failed'
  | 'no-rules-survived'
  | 'timed-out'
  | 'aborted'
  | 'worktree-failed';

export interface VerifyFlowSetupResult {
  ok: boolean;
  failureReason?: VerifyFlowSetupFailureReason;
  finding?: string;
  setupOutputTail?: string;
  verdicts: RuleVerificationVerdict[];
  prunedYaml: string | null;
  acceptedCount: number;
  rejectedCount: number;
}

export type VerifyJobState = 'running' | 'done';

export interface VerifyFlowSetupJob {
  id: string;
  baseSha: string;
  state: VerifyJobState;
  result?: VerifyFlowSetupResult;
  controller: AbortController;
}

export interface VerifyFlowSetupDeps {
  runCommand: (
    command: string,
    cwd: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<RunOutcome>;
  createTempWorktree: typeof createTempWorktree;
  removeTempWorktree: typeof removeTempWorktree;
  listTrackedFiles: (worktreePath: string) => Promise<string[]>;
  readPostCreate: (worktreePath: string) => string[];
  /** Write canary files into the temp checkout (no-op in fake-executor tests when overridden). */
  writeCanaryFile: (worktreePath: string, relPath: string, content: string) => void;
}

async function defaultListTrackedFiles(worktreePath: string): Promise<string[]> {
  const res = await gitRead(['ls-files'], { cwd: worktreePath, reject: false });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertSafeRelativePath(baseDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`Invalid relative path: ${relPath}`);
  }
  const full = resolve(baseDir, normalized);
  const root = resolve(baseDir);
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new Error(`Path escapes worktree: ${relPath}`);
  }
  return full;
}

function defaultWriteCanaryFile(worktreePath: string, relPath: string, content: string): void {
  const dest = assertSafeRelativePath(worktreePath, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

const defaultDeps: VerifyFlowSetupDeps = {
  runCommand: runShellCommand,
  createTempWorktree,
  removeTempWorktree,
  listTrackedFiles: defaultListTrackedFiles,
  readPostCreate: (wt) => readProjectConfig(wt)?.postCreate ?? [],
  writeCanaryFile: defaultWriteCanaryFile,
};

function matchesAnyGlob(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(file, p));
}

function outputNamesFile(output: string, filePath: string, cwd?: string): boolean {
  if (!output) return false;
  if (output.includes(filePath)) return true;
  if (cwd) {
    const prefix = `${cwd.replace(/\/+$/, '')}/`;
    if (filePath.startsWith(prefix) && output.includes(filePath.slice(prefix.length))) {
      return true;
    }
  }
  const base = basename(filePath);
  return base.length > 0 && output.includes(base);
}

function toCheckRun(command: string, files: string[], outcome: RunOutcome): RuleCheckRun {
  return {
    command,
    files,
    exitCode: outcome.kind === 'exited' ? outcome.exitCode : null,
    timedOut: outcome.kind === 'timed-out',
    aborted: outcome.kind === 'aborted',
    outputTail: outcome.output.slice(-OUTPUT_TAIL),
  };
}

function resolveCanaryContent(
  path: string,
  inlineContent: string | undefined,
  agentWorktreePath: string | undefined,
): string | null {
  if (inlineContent !== undefined) return inlineContent;
  if (!agentWorktreePath) return null;
  try {
    const full = assertSafeRelativePath(agentWorktreePath, path);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

type RuleRuns = Pick<
  RuleVerificationVerdict,
  'passingRun' | 'failingRun' | 'existingRun' | 'twoFileRun'
>;

type StopKind = 'aborted' | 'timed-out';

interface RuleOutcome {
  verdict: RuleVerificationVerdict;
  /** Set when the job must end now (cancelled or out of time). */
  stop?: StopKind;
}

interface RuleCheckContext {
  trackedFiles: string[];
  canaryPaths: Set<string>;
  canaryByRule: Map<number, SetupCanarySpec>;
  missingCanaries: Map<number, string>;
  infraSet: Set<string>;
  supportGlobs: string[];
  run: (command: string, ruleCwd?: string) => Promise<RunOutcome>;
}

interface StagedCanaries {
  canaryByRule: Map<number, SetupCanarySpec>;
  canaryPaths: Set<string>;
  missingCanaries: Map<number, string>;
}

const STOP_FINDINGS: Record<StopKind, string> = {
  aborted: 'Verification was cancelled',
  'timed-out': 'Verification exceeded its time budget',
};

function failedResult(
  failureReason: VerifyFlowSetupFailureReason,
  finding: string,
  totalRules: number,
  verdicts: RuleVerificationVerdict[] = [],
  setupOutputTail?: string,
): VerifyFlowSetupResult {
  const acceptedCount = verdicts.filter((v) => v.accepted).length;
  const result: VerifyFlowSetupResult = {
    ok: false,
    failureReason,
    finding,
    verdicts,
    prunedYaml: null,
    acceptedCount,
    rejectedCount: totalRules - acceptedCount,
  };
  if (setupOutputTail !== undefined) result.setupOutputTail = setupOutputTail;
  return result;
}

/** Copy ONLY the declared canary files into the clean worktree. */
function stageCanaries(
  deps: VerifyFlowSetupDeps,
  worktreePath: string,
  request: VerifyFlowSetupRequest,
): StagedCanaries {
  const staged: StagedCanaries = {
    canaryByRule: new Map(),
    canaryPaths: new Set(),
    missingCanaries: new Map(),
  };
  for (const spec of request.canaries) {
    staged.canaryByRule.set(spec.ruleIndex, spec);
    const passContent = resolveCanaryContent(
      spec.passingPath,
      spec.passingContent,
      request.agentWorktreePath,
    );
    const failContent = resolveCanaryContent(
      spec.failingPath,
      spec.failingContent,
      request.agentWorktreePath,
    );
    if (passContent === null) {
      staged.missingCanaries.set(
        spec.ruleIndex,
        `Passing canary file not found: ${spec.passingPath}`,
      );
      continue;
    }
    if (failContent === null) {
      staged.missingCanaries.set(
        spec.ruleIndex,
        `Failing canary file not found: ${spec.failingPath}`,
      );
      continue;
    }
    try {
      deps.writeCanaryFile(worktreePath, spec.passingPath, passContent);
      deps.writeCanaryFile(worktreePath, spec.failingPath, failContent);
      staged.canaryPaths.add(spec.passingPath);
      staged.canaryPaths.add(spec.failingPath);
    } catch (error) {
      staged.missingCanaries.set(
        spec.ruleIndex,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return staged;
}

/** Run `setup_command` (or `.funny.json` `postCreate`); a failure result ends the job. */
async function runSetupCommands(
  deps: VerifyFlowSetupDeps,
  worktreePath: string,
  request: VerifyFlowSetupRequest,
  signal: AbortSignal,
  remaining: () => number,
): Promise<VerifyFlowSetupResult | null> {
  const total = request.rules.length;
  const commands = request.setupCommand
    ? [request.setupCommand]
    : deps.readPostCreate(worktreePath);
  for (const command of commands) {
    if (signal.aborted) {
      return failedResult('aborted', 'Verification was cancelled during setup', total);
    }
    const outcome = await deps.runCommand(command, worktreePath, signal, remaining());
    const tail = outcome.output.slice(-OUTPUT_TAIL);
    if (outcome.kind === 'aborted') {
      return failedResult('aborted', 'Verification was cancelled during setup', total, [], tail);
    }
    if (outcome.kind === 'timed-out') {
      return failedResult('timed-out', `Setup command timed out: \`${command}\``, total, [], tail);
    }
    if (outcome.exitCode !== 0) {
      return failedResult(
        'setup-failed',
        `Setup command \`${command}\` exited with code ${outcome.exitCode}`,
        total,
        [],
        tail,
      );
    }
  }
  return null;
}

/** The rule's own preconditions: the `{{files}}` placeholder and a matching canary pair. */
function canaryForRule(
  rc: RuleCheckContext,
  rule: ProofRule,
  ruleIndex: number,
): { ok: true; canary: SetupCanarySpec } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!rule.command.includes('{{files}}')) {
    return refuse('Rule command does not include {{files}} placeholder');
  }
  const missing = rc.missingCanaries.get(ruleIndex);
  if (missing) return refuse(missing);
  const canary = rc.canaryByRule.get(ruleIndex);
  if (!canary) return refuse('No passing/failing canary pair provided for this rule');
  if (!matchesAnyGlob(canary.passingPath, rule.globs)) {
    return refuse(`Passing canary "${canary.passingPath}" does not match rule globs`);
  }
  if (!matchesAnyGlob(canary.failingPath, rule.globs)) {
    return refuse(`Failing canary "${canary.failingPath}" does not match rule globs`);
  }
  return { ok: true, canary };
}

/** One rule being verified: its base verdict and the runs made so far. */
interface RuleAttempt {
  rc: RuleCheckContext;
  rule: ProofRule;
  base: RuleVerificationVerdict;
  runs: RuleRuns;
}

/** A check's answer: the rule's final outcome, or null to go on to the next check. */
type CheckStep = RuleOutcome | null;

const rejectRule = (a: RuleAttempt, reason: string): RuleOutcome => ({
  verdict: { ...a.base, ...a.runs, reason },
});

const stopRule = (a: RuleAttempt, kind: StopKind): RuleOutcome => ({
  verdict: { ...a.base, ...a.runs, reason: kind === 'aborted' ? 'Aborted' : 'Timed out' },
  stop: kind,
});

async function execRule(a: RuleAttempt, files: string[]) {
  const command = fillCommand(a.rule.command, files, a.rule.cwd);
  const outcome = await a.rc.run(command, a.rule.cwd);
  return { outcome, checkRun: toCheckRun(command, files, outcome) };
}

/** Check 1: the passing canary exits 0 and the output names it. */
async function checkPassingCanary(a: RuleAttempt, canary: SetupCanarySpec): Promise<CheckStep> {
  const pass = await execRule(a, [canary.passingPath]);
  a.runs.passingRun = pass.checkRun;
  if (pass.outcome.kind !== 'exited') return stopRule(a, pass.outcome.kind);
  if (pass.outcome.exitCode !== 0) {
    return rejectRule(a, `Passing canary exited with code ${pass.outcome.exitCode}`);
  }
  if (!outputNamesFile(pass.outcome.output, canary.passingPath, a.rule.cwd)) {
    return rejectRule(a, `Command output did not name the passing canary "${canary.passingPath}"`);
  }
  return null;
}

/** Check 2: the failing canary fails conclusively and the output names it. */
async function checkFailingCanary(a: RuleAttempt, canary: SetupCanarySpec): Promise<CheckStep> {
  const fail = await execRule(a, [canary.failingPath]);
  a.runs.failingRun = fail.checkRun;
  if (fail.outcome.kind !== 'exited') return stopRule(a, fail.outcome.kind);
  if (fail.outcome.exitCode === 0) {
    return rejectRule(a, 'Failing canary unexpectedly exited with code 0');
  }
  const inconclusive = inconclusiveBaseFailure(fail.outcome);
  if (inconclusive) return rejectRule(a, `Failing canary was inconclusive: ${inconclusive}`);
  if (!outputNamesFile(fail.outcome.output, canary.failingPath, a.rule.cwd)) {
    return rejectRule(a, `Command output did not name the failing canary "${canary.failingPath}"`);
  }
  return null;
}

/** Up to 3 existing test files the rule covers, leaving out canaries, infrastructure and support files. */
function existingCandidates(a: RuleAttempt): string[] {
  const { rc, rule } = a;
  return rc.trackedFiles
    .filter(
      (file) =>
        !rc.canaryPaths.has(file) &&
        !rc.infraSet.has(file) &&
        !matchesAnyGlob(file, rc.supportGlobs) &&
        matchesAnyGlob(file, rule.globs),
    )
    .slice(0, MAX_EXISTING_CANDIDATES);
}

/** Check 3: at least one existing matched test file passes; returns it. */
async function findPassingExisting(
  a: RuleAttempt,
): Promise<{ ok: true; file: string } | { ok: false; outcome: RuleOutcome }> {
  const candidates = existingCandidates(a);
  if (candidates.length === 0) {
    return {
      ok: false,
      outcome: rejectRule(a, 'No existing non-infrastructure test file matched the rule globs'),
    };
  }
  for (const candidate of candidates) {
    const existing = await execRule(a, [candidate]);
    a.runs.existingRun = existing.checkRun;
    if (existing.outcome.kind !== 'exited') {
      return { ok: false, outcome: stopRule(a, existing.outcome.kind) };
    }
    if (existing.outcome.exitCode === 0) return { ok: true, file: candidate };
  }
  return {
    ok: false,
    outcome: rejectRule(a, `None of the ${candidates.length} matched existing test file(s) passed`),
  };
}

/** Check 4: passing canary + that existing file in one run exit 0 and both are named. */
async function checkTwoFileRun(
  a: RuleAttempt,
  canary: SetupCanarySpec,
  existingFile: string,
): Promise<CheckStep> {
  const two = await execRule(a, [canary.passingPath, existingFile]);
  a.runs.twoFileRun = two.checkRun;
  if (two.outcome.kind !== 'exited') return stopRule(a, two.outcome.kind);
  if (two.outcome.exitCode !== 0) {
    return rejectRule(a, `Two-file run exited with code ${two.outcome.exitCode}`);
  }
  const namesBoth =
    outputNamesFile(two.outcome.output, canary.passingPath, a.rule.cwd) &&
    outputNamesFile(two.outcome.output, existingFile, a.rule.cwd);
  return namesBoth ? null : rejectRule(a, 'Two-file run output did not name both files');
}

/** Run one rule's four checks (see the module comment). */
async function verifyRule(
  rc: RuleCheckContext,
  rule: ProofRule,
  ruleIndex: number,
): Promise<RuleOutcome> {
  const base: RuleVerificationVerdict = {
    ruleIndex,
    globs: rule.globs,
    command: rule.command,
    accepted: false,
  };
  if (rule.cwd) base.cwd = rule.cwd;
  const a: RuleAttempt = { rc, rule, base, runs: {} };

  const pair = canaryForRule(rc, rule, ruleIndex);
  if (!pair.ok) return rejectRule(a, pair.reason);
  const { canary } = pair;

  const afterCanaries =
    (await checkPassingCanary(a, canary)) ?? (await checkFailingCanary(a, canary));
  if (afterCanaries) return afterCanaries;
  const existing = await findPassingExisting(a);
  if (!existing.ok) return existing.outcome;
  const afterTwo = await checkTwoFileRun(a, canary, existing.file);
  return afterTwo ?? { verdict: { ...base, ...a.runs, accepted: true } };
}

/** Verify each rule in order; the job ends at the first cancellation or out of time. */
async function verifyRules(
  rc: RuleCheckContext,
  request: VerifyFlowSetupRequest,
  signal: AbortSignal,
  remaining: () => number,
): Promise<{ verdicts: RuleVerificationVerdict[]; stop: StopKind | null }> {
  const verdicts: RuleVerificationVerdict[] = [];
  for (let i = 0; i < request.rules.length; i++) {
    if (signal.aborted) return { verdicts, stop: 'aborted' };
    if (remaining() <= 0) return { verdicts, stop: 'timed-out' };
    const outcome = await verifyRule(rc, request.rules[i]!, i);
    verdicts.push(outcome.verdict);
    if (outcome.stop) return { verdicts, stop: outcome.stop };
  }
  return { verdicts, stop: null };
}

/** The job's result from its verdicts: the pruned flow file, or why nothing survived. */
function resultOf(
  request: VerifyFlowSetupRequest,
  verdicts: RuleVerificationVerdict[],
): VerifyFlowSetupResult {
  const total = request.rules.length;
  const acceptedIndices = new Set<number>();
  for (const v of verdicts) if (v.accepted) acceptedIndices.add(v.ruleIndex);
  const acceptedCount = acceptedIndices.size;
  if (acceptedCount === 0) {
    return failedResult(
      'no-rules-survived',
      'No generated regression proof rule passed verification',
      total,
      verdicts,
    );
  }
  return {
    ok: true,
    verdicts,
    prunedYaml: pruneRegressionProofRules(request.workflowYaml, acceptedIndices),
    acceptedCount,
    rejectedCount: total - acceptedCount,
  };
}

export async function runFlowSetupVerification(
  projectPath: string,
  request: VerifyFlowSetupRequest,
  signal: AbortSignal,
  overrides: Partial<VerifyFlowSetupDeps> = {},
): Promise<VerifyFlowSetupResult> {
  const deps: VerifyFlowSetupDeps = { ...defaultDeps, ...overrides };
  const total = request.rules.length;
  const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  const remaining = () => deadline - Date.now();

  const created = await deps.createTempWorktree(projectPath, request.baseSha, 'flow-setup-verify');
  if (created.isErr()) {
    return failedResult(
      'worktree-failed',
      `Could not create clean verification checkout: ${created.error.message}`,
      total,
    );
  }

  const worktreePath = created.value;
  try {
    // List tracked files in the clean base checkout BEFORE writing canaries in.
    const trackedFiles = await deps.listTrackedFiles(worktreePath);
    const staged = stageCanaries(deps, worktreePath, request);

    const setupFailure = await runSetupCommands(deps, worktreePath, request, signal, remaining);
    if (setupFailure) return setupFailure;

    const supportGlobs = request.supportGlobs?.length
      ? request.supportGlobs
      : DEFAULT_SUPPORT_GLOBS;
    const rc: RuleCheckContext = {
      ...staged,
      trackedFiles,
      infraSet: new Set(request.infraFiles ?? []),
      supportGlobs,
      run: (command, ruleCwd) => {
        const dir = ruleCwd ? assertSafeRelativePath(worktreePath, ruleCwd) : worktreePath;
        return deps.runCommand(command, dir, signal, remaining());
      },
    };

    const { verdicts, stop } = await verifyRules(rc, request, signal, remaining);
    return stop
      ? failedResult(stop, STOP_FINDINGS[stop], total, verdicts)
      : resultOf(request, verdicts);
  } finally {
    await deps.removeTempWorktree(projectPath, worktreePath).match(
      () => {},
      () => {},
    );
  }
}

// ── Job registry ──────────────────────────────────────────────

const jobs = new Map<string, VerifyFlowSetupJob>();
const swept = new Map<string, Promise<void>>();

function sweepOnce(projectPath: string): Promise<void> {
  let pending = swept.get(projectPath);
  if (!pending) {
    pending = sweepTempWorktrees(projectPath).match(
      () => {},
      (error) => {
        log.warn('Could not sweep leftover verification worktrees', {
          namespace: ns,
          projectPath,
          error: error.message,
        });
      },
    );
    swept.set(projectPath, pending);
  }
  return pending;
}

export function startFlowSetupVerifyJob(
  threadId: string,
  projectPath: string,
  request: VerifyFlowSetupRequest,
): VerifyFlowSetupJob {
  const existing = jobs.get(threadId);
  if (existing) {
    if (existing.state === 'running' && existing.baseSha === request.baseSha) {
      return existing;
    }
    existing.controller.abort();
    jobs.delete(threadId);
  }

  const controller = new AbortController();
  const job: VerifyFlowSetupJob = {
    id: randomUUID(),
    baseSha: request.baseSha,
    state: 'running',
    controller,
  };
  jobs.set(threadId, job);

  sweepOnce(projectPath)
    .then(() => runFlowSetupVerification(projectPath, request, controller.signal))
    .then((result) => {
      job.result = result;
      job.state = 'done';
      log.info('Flow setup verification completed', {
        namespace: ns,
        threadId,
        ok: result.ok,
        acceptedCount: result.acceptedCount,
        rejectedCount: result.rejectedCount,
      });
    })
    .catch((err) => {
      job.result = {
        ok: false,
        failureReason: 'worktree-failed',
        finding: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
        verdicts: [],
        prunedYaml: null,
        acceptedCount: 0,
        rejectedCount: request.rules.length,
      };
      job.state = 'done';
      log.error('Flow setup verification failed', {
        namespace: ns,
        threadId,
        error: String(err),
      });
    });

  return job;
}

export function getFlowSetupVerifyJob(threadId: string, jobId: string): VerifyFlowSetupJob | null {
  const job = jobs.get(threadId);
  if (!job || job.id !== jobId) return null;
  return job;
}

export function cancelFlowSetupVerifyJob(threadId: string, jobId: string): boolean {
  const job = getFlowSetupVerifyJob(threadId, jobId);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(threadId);
  log.info('Flow setup verification cancelled', { namespace: ns, threadId, jobId });
  return true;
}
