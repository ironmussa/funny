/**
 * The `fix` step of a factory run: CI failed on the run's pull request, or
 * the pull request conflicts with its base.
 *
 * It resumes the agent session of the run (`sessionId`), so the agent keeps
 * the context of its implementation, and asks it to fix the failing checks
 * (with their log excerpts) or to rebase the branch onto the base and resolve
 * the conflicts. Then the local checks run with in-place fixes, any leftover
 * changes are committed with the configured author, and the branch is pushed
 * (with `--force-with-lease` after a rebase).
 *
 * Like `implement`, it appends its events to the run's event file and writes
 * the outcome to the exit marker: `pushed`, or `failed` (agent or infra).
 */

import { existsSync } from 'fs';
import { resolve } from 'path';

import type { IAgentProcessFactory } from '@funny/core/agents';
import { git } from '@funny/core/git';
import type { ActionResult } from '@funny/workflows/compiler';
import { z } from 'zod';

import { WorkspaceActionProvider } from '../adapters/workspace-action-provider.js';
import type { StepOutcome } from '../domain/step-outcome.js';
import { checksPrompt, conflictPrompt, localChecksPrompt } from './fix-prompts.js';
import { stepIo, stepSpecFields } from './step-io.js';

const failingCheckSchema = z.object({
  name: z.string().min(1),
  /** GitHub's conclusion (`failure`, `timed_out`, …). */
  conclusion: z.string(),
  /** The end of the check's log, or its summary. */
  excerpt: z.string(),
});

export const fixStepSpecSchema = z.object({
  ...stepSpecFields,
  /** The agent session of the run, resumed so the fix has the implementation's context. */
  sessionId: z.string().min(1),
  issue: z.object({ number: z.number().int().positive(), title: z.string().min(1) }),
  prUrl: z.string().min(1),
  /** What to fix. */
  problem: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('checks'), checks: z.array(failingCheckSchema).min(1) }),
    z.object({ kind: z.literal('conflict') }),
  ]),
});

export type FixStepSpec = z.infer<typeof fixStepSpecSchema>;
export type FailingCheck = z.infer<typeof failingCheckSchema>;

export interface FixStepDeps {
  /** The workspace: the run's checkout, on `spec.branch`. */
  cwd: string;
  agents: IAgentProcessFactory;
  print: (line: string) => void;
  now?: () => Date;
}

/** Local check attempts after the agent's fix (the first run plus two fixes). */
const LOCAL_CHECK_ATTEMPTS = 3;

export async function runFixStep(spec: FixStepSpec, deps: FixStepDeps): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  const { report, finish } = stepIo(spec, now);
  const provider = new WorkspaceActionProvider({
    cwd: deps.cwd,
    branch: spec.branch,
    base: spec.base,
    author: spec.author,
    model: spec.model,
    agents: deps.agents,
    // `fix` never opens a pull request: the run already has one.
    pullRequests: { openDraft: async () => ({ ok: false, error: 'fix opens no pull request' }) },
    onAgentMessage: (message) => report('factory.cli_message', { cli_message: message }),
  });
  provider.sessionId = spec.sessionId;

  report('factory.started', { step: 'fix', problem: spec.problem.kind, branch: spec.branch });
  let outcome: StepOutcome;
  try {
    outcome = await fix(spec, deps.cwd, provider);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', failure: 'infra', reason, sessionId: provider.sessionId };
  }
  return finish(outcome, deps.print, { step: 'fix' });
}

type Failed = Extract<StepOutcome, { kind: 'failed' }>;

type Problem = { failure: Failed['failure']; reason: string };

/** A failed action as the step's failure; null when it succeeded. */
const problemOf = (
  result: ActionResult,
  failure: Failed['failure'],
  fallback: string,
): Problem | null => (result.ok ? null : { failure, reason: result.error || fallback });

/** The agent's fix, verified: a finished rebase onto the base for a conflict, then the checks. */
async function agentFix(
  spec: FixStepSpec,
  cwd: string,
  provider: WorkspaceActionProvider,
): Promise<Problem | null> {
  const prompt =
    spec.problem.kind === 'conflict'
      ? conflictPrompt(spec)
      : checksPrompt(spec, spec.problem.checks);
  const agent = await provider.spawnAgent({ prompt, cwd });
  const agentProblem = problemOf(agent, provider.lastFailure ?? 'agent', 'the agent failed');
  if (agentProblem) return agentProblem;
  if (spec.problem.kind === 'conflict') {
    const rebased = problemOf(
      await rebasedOntoBase(cwd, spec.base),
      'agent',
      'the rebase did not finish',
    );
    if (rebased) return rebased;
  }
  if (!spec.checkCommand) return null;
  return problemOf(
    await runLocalChecks(spec.checkCommand, cwd, provider),
    'agent',
    'the checks failed',
  );
}

async function fix(
  spec: FixStepSpec,
  cwd: string,
  provider: WorkspaceActionProvider,
): Promise<StepOutcome> {
  const failed = (failure: Failed['failure'], reason: string): Failed => ({
    kind: 'failed',
    failure,
    reason,
    sessionId: provider.sessionId,
  });
  // The base as it is now: the checks ran against it, and a rebase goes onto it.
  const fetched = await git(
    ['fetch', '--quiet', 'origin', `+refs/heads/${spec.base}:refs/remotes/origin/${spec.base}`],
    cwd,
  );
  if (fetched.isErr()) return failed('infra', `git fetch failed: ${fetched.error.message}`);

  const before = await git(['rev-parse', 'HEAD'], cwd);
  if (before.isErr()) return failed('infra', before.error.message);

  const problem = await agentFix(spec, cwd, provider);
  if (problem) return failed(problem.failure, problem.reason);

  const uncommitted = await commitFix(spec, cwd, provider, before.value.trim());
  if (uncommitted) return failed(uncommitted.failure, uncommitted.reason);
  const pushed = await provider.gitPush({
    branch: spec.branch,
    force: spec.problem.kind === 'conflict',
    cwd,
  });
  if (!pushed.ok) return failed('infra', pushed.error ?? 'push failed');
  return { kind: 'pushed', sessionId: provider.sessionId };
}

/** Commit what is left; a fix that leaves HEAD where it was changed nothing. */
async function commitFix(
  spec: FixStepSpec,
  cwd: string,
  provider: WorkspaceActionProvider,
  before: string,
): Promise<Problem | null> {
  const message = `Fix CI for #${spec.issue.number}`;
  const committed = await provider.gitCommit({ message, cwd });
  const problem = problemOf(committed, provider.lastFailure ?? 'agent', 'commit failed');
  if (problem) return problem;
  // CI would only run again on the same commit and fail the same way.
  const after = await git(['rev-parse', 'HEAD'], cwd);
  const unchanged = after.isOk() && after.value.trim() === before;
  return unchanged ? { failure: 'agent', reason: 'the fix changed nothing' } : null;
}

/** The checks, with up to two in-place fixes by the same agent. */
async function runLocalChecks(
  command: string,
  cwd: string,
  provider: WorkspaceActionProvider,
): Promise<ActionResult> {
  let result: ActionResult = { ok: false };
  for (let attempt = 1; attempt <= LOCAL_CHECK_ATTEMPTS; attempt++) {
    result = await provider.runCommand({ command, cwd });
    if (result.ok || attempt === LOCAL_CHECK_ATTEMPTS) return result;
    const again = await provider.spawnAgent({
      prompt: localChecksPrompt(command, result.error ?? ''),
      cwd,
    });
    if (!again.ok) return again;
  }
  return result;
}

/** The branch contains the current base and no rebase is left half done. */
async function rebasedOntoBase(cwd: string, base: string): Promise<ActionResult> {
  for (const state of ['rebase-merge', 'rebase-apply']) {
    const path = await git(['rev-parse', '--git-path', state], cwd);
    if (path.isOk() && existsSync(resolve(cwd, path.value.trim()))) {
      return { ok: false, error: 'the rebase was left unfinished' };
    }
  }
  const contains = await git(['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'], cwd);
  return contains.isOk()
    ? { ok: true }
    : { ok: false, error: `the branch is still not rebased onto origin/${base}` };
}
