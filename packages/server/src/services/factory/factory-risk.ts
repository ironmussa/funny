/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The risk class of a pull request's commit (change factory-agent-roles, D6):
 * `high` when the diff weakens a test, is large (tests and docs aside), touches a sensitive path, or
 * the run's contract named a risk; `low` otherwise. Decided here from the diff
 * and the factory's settings. No agent result is an input, so no agent result
 * can lower it; with `auto_merge: low_risk` a high-risk change waits for a
 * person.
 */

import type { PullRequestFiles } from '@funny/core/github-app';
import { DEFAULT_MAX_LOW_RISK_LINES, type FactoryRisk } from '@funny/shared/contracts/factory';

import { isTestFile, type TestWeakeningFinding } from './factory-test-weakening.js';

/**
 * A change with more counted lines than this is high risk (see
 * `countsTowardSize`), unless the factory sets its own limit.
 */
export const MAX_LOW_RISK_LINES = DEFAULT_MAX_LOW_RISK_LINES;

/**
 * Paths that make any change high risk, whatever the factory configures: CI
 * and repository settings, database migrations, and authentication code.
 */
const DEFAULT_SENSITIVE_PATHS = [
  '.github/**',
  '**/migrations/**',
  '**/migrate.ts',
  '**/auth/**',
] as const;

/** Generated lockfiles: their line counts say nothing about the size of the change. */
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

/** Prose: any Markdown file, wherever it is. */
const MARKDOWN = /\.md$/i;

/** Translation catalogs, Storybook stories and test snapshots. */
const NOT_CODE =
  /(^|\/)(locales|i18n)\/.*\.json$|\.stories\.[cm]?[jt]sx?$|(^|\/)__snapshots__\/|\.snap$/;

/**
 * Whether a file's lines count toward the size of the change. Size stands for
 * how much code a person would have to read, so tests (their weakening is its
 * own reason), Markdown, lockfiles, translations, stories and snapshots do not
 * count, nor what matches one of the factory's `ignoredPaths`. Sensitive paths
 * are checked on every file, counted or not.
 */
export function countsTowardSize(path: string, ignoredPaths: readonly string[] = []): boolean {
  return !(
    LOCKFILE.test(path) ||
    MARKDOWN.test(path) ||
    NOT_CODE.test(path) ||
    isTestFile(path) ||
    ignoredPaths.some((glob) => matches(glob, path))
  );
}

/** At most this many reasons are kept; the rest are counted in the last one. */
const MAX_REASONS = 12;

export interface RiskInput {
  headSha: string;
  change: PullRequestFiles;
  findings: readonly TestWeakeningFinding[];
  /** The factory's own sensitive globs, added to the default list. */
  sensitivePaths?: readonly string[];
  /** The factory's size limit (default `MAX_LOW_RISK_LINES`). */
  maxLowRiskLines?: number;
  /** The factory's globs left out of the size, besides the default list. */
  sizeIgnoredPaths?: readonly string[];
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
  const limit = input.maxLowRiskLines ?? MAX_LOW_RISK_LINES;
  const lines = input.change.files
    .filter((file) => countsTowardSize(file.path, input.sizeIgnoredPaths))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  return lines > limit
    ? [`${lines} changed lines outside tests and docs (more than ${limit})`]
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
