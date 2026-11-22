/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The risk class of a pull request's commit (change factory-agent-roles, D6):
 * `high` when the diff weakens a test, is large, touches a sensitive path, or
 * the run's contract named a risk; `low` otherwise. Decided here from the diff
 * and the factory's settings. No agent result is an input, so no agent result
 * can lower it; with `auto_merge: low_risk` a high-risk change waits for a
 * person.
 */

import type { PullRequestFiles } from '@funny/core/github-app';
import type { FactoryRisk } from '@funny/shared/contracts/factory';

import type { TestWeakeningFinding } from './factory-test-weakening.js';

/** A change with more changed lines than this (lockfiles aside) is high risk. */
export const MAX_LOW_RISK_LINES = 400;

/**
 * Paths that make any change high risk, whatever the factory configures: CI
 * and repository settings, database migrations, and authentication code.
 */
export const DEFAULT_SENSITIVE_PATHS = [
  '.github/**',
  '**/migrations/**',
  '**/migrate.ts',
  '**/auth/**',
] as const;

/** Generated lockfiles: their line counts say nothing about the size of the change. */
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

/** At most this many reasons are kept; the rest are counted in the last one. */
const MAX_REASONS = 12;

export interface RiskInput {
  headSha: string;
  change: PullRequestFiles;
  findings: readonly TestWeakeningFinding[];
  /** The factory's own sensitive globs, added to the default list. */
  sensitivePaths?: readonly string[];
  /** Risks the run's contract named (triage); absent for a run without a contract. */
  riskHints?: readonly string[];
}

/** Whether `path` matches `glob`; a glob that cannot be compiled matches nothing. */
function matches(glob: string, path: string): boolean {
  try {
    return new Bun.Glob(glob).match(path);
  } catch {
    return false;
  }
}

function sensitiveReasons(input: RiskInput): string[] {
  const globs = [...DEFAULT_SENSITIVE_PATHS, ...(input.sensitivePaths ?? [])];
  const reasons: string[] = [];
  for (const file of input.change.files) {
    const paths = file.previousPath ? [file.path, file.previousPath] : [file.path];
    const glob = globs.find((candidate) => paths.some((path) => matches(candidate, path)));
    if (glob) reasons.push(`touches a sensitive path: ${file.path} (${glob})`);
  }
  return reasons;
}

function sizeReasons(input: RiskInput): string[] {
  const lines = input.change.files
    .filter((file) => !LOCKFILE.test(file.path))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  return lines > MAX_LOW_RISK_LINES
    ? [`${lines} changed lines (more than ${MAX_LOW_RISK_LINES})`]
    : [];
}

function capped(reasons: string[]): string[] {
  if (reasons.length <= MAX_REASONS) return reasons;
  const rest = reasons.length - (MAX_REASONS - 1);
  return [...reasons.slice(0, MAX_REASONS - 1), `and ${rest} more`];
}

export function classifyRisk(input: RiskInput): FactoryRisk {
  const reasons = [
    ...input.findings.map(
      (finding) => `${finding.kind}${finding.path ? ` in ${finding.path}` : ''}: ${finding.detail}`,
    ),
    ...sizeReasons(input),
    ...sensitiveReasons(input),
    ...(input.riskHints ?? []).map((hint) => `the contract names a risk: ${hint.slice(0, 200)}`),
  ];
  return {
    headSha: input.headSha,
    level: reasons.length > 0 ? 'high' : 'low',
    reasons: capped(reasons),
  };
}
