/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * Running a regression proof on a run's thread (change factory-quality-gates):
 * start the job on the enabler's runner, poll it until done, and read its
 * result. Shared by the `regression_proof` / `merge` steps (the action
 * provider) and the watcher, which re-proves a new head while a run waits on
 * auto-merge. Also what a verdict means: whether it allows a merge, and the
 * check run that publishes it.
 */

import { sleep as interruptibleSleep } from '@funny/shared/async';
import type { RegressionProofOpts } from '@funny/workflows/compiler';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import type { FactoryProofCheck } from './factory-pull-requests.js';
import type { RegressionProofRecord } from './factory-runs.js';

/** Start, poll and stop a proof job on the runner of a run's thread. */
export interface FactoryProofDeps {
  startProof(
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Result<{ proofId: string; state: string }, string>>;
  pollProof(
    threadId: string,
    proofId: string,
  ): Promise<Result<{ state: string; result?: unknown }, string>>;
  /** Stop a proof the factory no longer waits for (best effort). */
  cancelProof?(threadId: string, proofId: string): Promise<void>;
  /** How often a running proof is polled (tests shorten it). */
  pollMs?: number;
  /** How long the runner may stay unreachable before the wait ends (tests shorten it). */
  offlineGraceMs?: number;
}

/** How often a running proof is polled. */
const PROOF_POLL_MS = 5_000;

/**
 * How long the runner may stay unreachable while a proof runs. A runner that
 * restarts (a deploy, a dev reload) is offline for a few seconds and then
 * answers `proof-not-found`, which starts the job again.
 */
const PROOF_OFFLINE_GRACE_MS = 180_000;

/** The prefix of a request error that never reached the runner. */
import { RUNNER_UNAVAILABLE_PREFIX } from './factory-runner-jobs.js';

/** The runner's proof result (`ProofResult` of the runtime). */
const PROOF_RESULT = z.object({
  verdict: z.enum(['pass', 'fail', 'skipped']),
  failureKind: z.enum(['test', 'environment']).optional(),
  headSha: z.string().optional(),
  finding: z.string().optional(),
  files: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  baseSha: z.string().optional(),
  outputTail: z.string().optional(),
});
export type ProofResultBody = z.infer<typeof PROOF_RESULT>;

export type ProofRun =
  | { kind: 'result'; result: ProofResultBody }
  /** It could not run or be read: no verdict. */
  | { kind: 'unavailable'; why: string };

/**
 * Run the proof of `threadId`'s checkout on its runner and wait for it. The
 * runner resolves the commit and the default branch; `timeoutMs` bounds the
 * whole proof there, and the job is stopped when the caller stops waiting.
 */
export async function proveOnRunner(
  proof: FactoryProofDeps,
  threadId: string,
  opts: RegressionProofOpts,
  signal: AbortSignal,
  /** Prove this commit instead of the checkout's HEAD (a head pushed from elsewhere). */
  headSha?: string,
  /** Let the runner fetch `headSha` when its checkout lacks it: only for a sandbox thread. */
  fetchHead = false,
): Promise<ProofRun> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const body: Record<string, unknown> = {
    rules: opts.rules ?? [],
    supportGlobs: opts.supportGlobs ?? [],
    setupCommand: opts.setupCommand,
    timeoutMs,
  };
  if (headSha) {
    body.headSha = headSha;
    body.fetchHead = fetchHead;
  }

  const started = await proof.startProof(threadId, body);
  if (started.isErr()) return unavailable(`could not start: ${started.error}`);
  const job: PolledJob = {
    threadId,
    body,
    proofId: started.value.proofId,
    restarted: false,
    offlineSince: null,
  };
  const pollMs = proof.pollMs ?? PROOF_POLL_MS;
  const graceMs = proof.offlineGraceMs ?? PROOF_OFFLINE_GRACE_MS;
  // The runner's budget plus slack for its git fetch and cleanup.
  const deadline = Date.now() + timeoutMs + 60_000;
  let wait = 0;

  while (Date.now() < deadline) {
    await interruptibleSleep(wait, signal).catch(() => undefined);
    if (signal.aborted) break;
    const look = await pollProofJob(proof, job, graceMs);
    if (look.kind === 'done') return look.run;
    wait = look.kind === 'restarted' ? 0 : pollMs;
  }

  await proof.cancelProof?.(threadId, job.proofId);
  return unavailable(signal.aborted ? 'the run was stopped.' : 'timed out waiting for the proof.');
}

const unavailable = (why: string): ProofRun => ({ kind: 'unavailable', why });

/** The proof job being waited for; `proofId` changes when it is started again. */
interface PolledJob {
  threadId: string;
  body: Record<string, unknown>;
  proofId: string;
  /** It was started again once already. */
  restarted: boolean;
  /** When the runner stopped answering, while it stays unreachable. */
  offlineSince: number | null;
}

type JobLook = { kind: 'done'; run: ProofRun } | { kind: 'running' } | { kind: 'restarted' };

/**
 * One look at the job: its verdict, still running, or started again. An
 * unreachable runner counts as running for `graceMs`: it is usually
 * restarting, and once back it answers `proof-not-found`.
 */
async function pollProofJob(
  proof: FactoryProofDeps,
  job: PolledJob,
  graceMs: number,
): Promise<JobLook> {
  const polled = await proof.pollProof(job.threadId, job.proofId);
  if (polled.isErr() && polled.error.startsWith(RUNNER_UNAVAILABLE_PREFIX)) {
    job.offlineSince ??= Date.now();
    if (Date.now() - job.offlineSince < graceMs) return { kind: 'running' };
    return { kind: 'done', run: unavailable(`poll failed: ${polled.error}`) };
  }
  job.offlineSince = null;
  if (polled.isErr()) return restartLostJob(proof, job, polled.error);
  if (polled.value.state !== 'done') return { kind: 'running' };
  const parsed = PROOF_RESULT.safeParse(polled.value.result);
  return {
    kind: 'done',
    run: parsed.success
      ? { kind: 'result', result: parsed.data }
      : unavailable('the runner sent no readable result.'),
  };
}

/** The runner lost the job (it restarted): start it once more; any other error ends the wait. */
async function restartLostJob(
  proof: FactoryProofDeps,
  job: PolledJob,
  error: string,
): Promise<JobLook> {
  if (error !== 'proof-not-found' || job.restarted) {
    return { kind: 'done', run: unavailable(`poll failed: ${error}`) };
  }
  job.restarted = true;
  const again = await proof.startProof(job.threadId, job.body);
  if (again.isErr()) return { kind: 'done', run: unavailable(`could not restart: ${again.error}`) };
  job.proofId = again.value.proofId;
  return { kind: 'restarted' };
}

/**
 * Whether the issue needs a regression test: never with an exempt label,
 * else per `requireTest` (default `always`; `labels` means only issues with
 * one of `labels`).
 */
export function regressionTestRequired(
  opts: Pick<RegressionProofOpts, 'requireTest' | 'labels' | 'exemptLabels'>,
  issueLabels: readonly string[],
): boolean {
  if (opts.exemptLabels?.some((label) => issueLabels.includes(label))) return false;
  const requireTest = opts.requireTest ?? 'always';
  if (requireTest === 'labels') return !!opts.labels?.some((l) => issueLabels.includes(l));
  return requireTest === 'always';
}

/** Whether a verdict lets the run merge: a pass, or a skip when no test is required. */
export function proofAllowsMerge(
  result: Pick<ProofResultBody, 'verdict'>,
  testRequired: boolean,
): boolean {
  return result.verdict === 'pass' || (result.verdict === 'skipped' && !testRequired);
}

/** What the run stores of a runner's result. */
export function proofRecordOf(result: ProofResultBody, ranAt = new Date()): RegressionProofRecord {
  return {
    headSha: result.headSha ?? '',
    verdict: result.verdict,
    finding: result.finding,
    files: result.files,
    commands: result.commands,
    baseSha: result.baseSha,
    outputTail: result.outputTail,
    ranAt: ranAt.toISOString(),
  };
}

/** GitHub's limit on a check run's summary is 65535 characters. */
const SUMMARY_LIMIT = 60_000;

/** A fenced block that cannot be closed early by the text it holds. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function proofCheckTitle(verdict: RegressionProofRecord['verdict'], allows: boolean): string {
  if (verdict === 'pass') return 'The changed tests catch the bug';
  if (verdict === 'fail') return 'Regression proof failed';
  return allows
    ? 'No regression test changed (none required)'
    : 'No regression test was added, but this issue needs one';
}

/** The check run that publishes a proof on its commit: success only when it allows a merge. */
export function proofCheckOf(
  proof: RegressionProofRecord,
  testRequired: boolean,
): FactoryProofCheck {
  const allows = proofAllowsMerge(proof, testRequired);
  const title = proofCheckTitle(proof.verdict, allows);
  const lines = [
    proof.verdict === 'pass'
      ? 'The changed tests pass on this commit (twice) and fail by an assertion on the commit the pull request branched from.'
      : (proof.finding ?? title),
  ];
  if (proof.carriedFrom) {
    lines.push(
      '',
      `The tests ran on \`${proof.carriedFrom}\`; this commit only merges the base branch into it, and its checks pass.`,
    );
  }
  if (proof.baseSha) lines.push('', `Base: \`${proof.baseSha}\``);
  if (proof.files?.length) lines.push('', '**Tests**', ...proof.files.map((f) => `- \`${f}\``));
  if (proof.commands?.length) lines.push('', '**Commands**', fenced(proof.commands.join('\n')));
  if (proof.outputTail) {
    lines.push(
      '',
      proof.verdict === 'pass' ? '**Output without the fix**' : '**Output**',
      fenced(proof.outputTail),
    );
  }
  const summary = lines.join('\n');
  return {
    headSha: proof.headSha,
    conclusion: allows ? 'success' : 'failure',
    title,
    summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}\n…` : summary,
  };
}
