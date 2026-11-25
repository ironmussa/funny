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

import { createHash } from 'node:crypto';

import type { PullRequestFiles } from '@funny/core/github-app';
import {
  contractRiskReason,
  DEFAULT_MAX_LOW_RISK_LINES,
  type FactoryRisk,
} from '@funny/shared/contracts/factory';

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
function countsTowardSize(path: string, ignoredPaths: readonly string[] = []): boolean {
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
  /**
   * The factory's size limit (default `MAX_LOW_RISK_LINES`); null: the size
   * gate is off and a change's size never makes it high risk.
   */
  maxLowRiskLines?: number | null;
  /** The factory's globs left out of the size, besides the default list. */
  sizeIgnoredPaths?: readonly string[];
  /** Risks the run's contract named (triage); absent for a run without a contract. */
  riskHints?: readonly string[];
  /**
   * The run is a lint cleanup (`lintCleanupSource`): triage classed it and
   * named only rules whose fix cannot change behavior, and no member said
   * otherwise. It lowers the risk, so the diff is still checked here.
   */
  lintCleanup?: boolean;
}

/**
 * Comments that silence a linter or the type checker. A lint cleanup that adds
 * one cleared the warning by hiding it.
 */
const SUPPRESSION =
  /(eslint-disable|oxlint-disable|biome-ignore|fallow-ignore|@ts-ignore|@ts-expect-error|@ts-nocheck)/;

/** Files that decide what the linter and the type checker report. */
const LINT_CONFIG =
  /(^|\/)(\.?oxlintrc(\.[a-z]+)?|oxlint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.fallowrc\.json|fallow\.toml|tsconfig[^/]*\.json)$/;

/** At most this many files are named in one refusal. */
const MAX_NAMED_FILES = 3;

const named = (paths: string[]) =>
  paths.length > MAX_NAMED_FILES
    ? `${paths.slice(0, MAX_NAMED_FILES).join(', ')} and ${paths.length - MAX_NAMED_FILES} more`
    : paths.join(', ');

/**
 * Why a change marked as a lint cleanup cannot be taken as one, from the diff
 * alone: it touches what the linter is configured with, it adds a suppression,
 * or part of it could not be read. Empty when it passes. This checks that the
 * warnings were not hidden, not that the change does nothing else: its tests,
 * its review and its checks answer that.
 */
function lintCleanupRefusals(input: RiskInput): RiskReason[] {
  const { files, truncated } = input.change;
  const code = files.filter(
    (file) => file.additions > 0 && countsTowardSize(file.path, input.sizeIgnoredPaths),
  );
  const pathsOf = (kept: PullRequestFiles['files']) => kept.map((file) => file.path);
  const checks: Array<{ key: string; paths: string[]; text: (paths: string) => string }> = [
    {
      key: 'config',
      paths: pathsOf(files.filter((file) => LINT_CONFIG.test(file.path))),
      text: (paths) => `it changes the lint or type-check configuration (${paths})`,
    },
    {
      key: 'suppression',
      paths: suppressingFiles(files, code),
      text: (paths) => `it adds a lint or type-check suppression (${paths})`,
    },
    {
      key: 'unread',
      paths: pathsOf(code.filter((file) => file.patch === undefined)),
      text: (paths) => `GitHub gave no diff for ${paths}, so no suppression could be looked for`,
    },
  ];
  const whole: RiskReason[] = truncated
    ? [{ key: 'lint-cleanup:truncated', text: 'the file list was not read whole' }]
    : [];
  return [
    ...whole,
    ...checks.flatMap((check) =>
      check.paths.length > 0
        ? [{ key: `lint-cleanup:${check.key}`, text: check.text(named(check.paths)) }]
        : [],
    ),
  ];
}

/** Whether the file's patch adds a comment that silences a linter or the type checker. */
/** A patch's suppression lines of one sign, without the sign and the indentation. */
const suppressionsIn = (patch: string, sign: '+' | '-') =>
  patch
    .split('\n')
    .filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3)))
    .map((line) => line.slice(1).trim())
    .filter((line) => SUPPRESSION.test(line));

/**
 * The code files that add a suppression the change did not remove elsewhere.
 * Splitting a long file moves its suppressions to the new files, word for
 * word: each one removed (from any file) pays for one added with the same
 * text, so only the net new ones count (seen on #489, whose split of
 * PromptEditor.tsx moved six).
 */
function suppressingFiles(
  files: PullRequestFiles['files'],
  code: PullRequestFiles['files'],
): string[] {
  const removed = new Map<string, number>();
  for (const file of files) {
    for (const line of suppressionsIn(file.patch ?? '', '-')) {
      removed.set(line, (removed.get(line) ?? 0) + 1);
    }
  }
  return code
    .filter((file) => {
      let adds = false;
      for (const line of suppressionsIn(file.patch ?? '', '+')) {
        const left = removed.get(line) ?? 0;
        if (left > 0) removed.set(line, left - 1);
        else adds = true;
      }
      return adds;
    })
    .map((file) => file.path);
}

/** Whether `path` matches `glob`; a glob that cannot be compiled matches nothing. */
function matches(glob: string, path: string): boolean {
  try {
    return new Bun.Glob(glob).match(path);
  } catch {
    return false;
  }
}

/**
 * A reason a change is high risk, with its stable key: what the reason is
 * about, without its numbers. Two commits with the same keys have the same
 * kinds of risk (openspec factory-approval-survives-integration, D4), so a
 * change that was over the size limit and grew has no new one.
 */
interface RiskReason {
  key: string;
  text: string;
}

/** The key of a change that could not be read (the caller classes it high risk itself). */
export const UNREADABLE_RISK_KEY = 'unreadable';

function sensitiveReasons(input: RiskInput): RiskReason[] {
  const globs = [...DEFAULT_SENSITIVE_PATHS, ...(input.sensitivePaths ?? [])];
  const reasons: RiskReason[] = [];
  for (const file of input.change.files) {
    const paths = file.previousPath ? [file.path, file.previousPath] : [file.path];
    const glob = globs.find((candidate) => paths.some((path) => matches(candidate, path)));
    if (glob) {
      reasons.push({
        key: `sensitive:${file.path}`,
        text: `touches a sensitive path: ${file.path} (${glob})`,
      });
    }
  }
  return reasons;
}

function sizeReasons(input: RiskInput): RiskReason[] {
  if (input.maxLowRiskLines === null) return [];
  const limit = input.maxLowRiskLines ?? MAX_LOW_RISK_LINES;
  const lines = input.change.files
    .filter((file) => countsTowardSize(file.path, input.sizeIgnoredPaths))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  return lines > limit
    ? [{ key: 'size', text: `${lines} changed lines outside tests and docs (more than ${limit})` }]
    : [];
}

const hintKey = (hint: string) =>
  `contract:${createHash('sha1').update(hint).digest('hex').slice(0, 12)}`;

function capped(reasons: string[]): string[] {
  if (reasons.length <= MAX_REASONS) return reasons;
  const rest = reasons.length - (MAX_REASONS - 1);
  return [...reasons.slice(0, MAX_REASONS - 1), `and ${rest} more`];
}

export function classifyRisk(input: RiskInput): FactoryRisk {
  // What a verified lint cleanup sets aside: its size and what triage guessed about it.
  const waivable: RiskReason[] = [
    ...sizeReasons(input),
    ...(input.riskHints ?? []).map((hint) => ({
      key: hintKey(hint),
      text: contractRiskReason(hint),
    })),
  ];
  // What holds whatever a member said: weakened tests and sensitive paths.
  const always: RiskReason[] = [
    ...input.findings.map((finding) => ({
      key: `finding:${finding.kind}:${finding.path ?? ''}`,
      text: `${finding.kind}${finding.path ? ` in ${finding.path}` : ''}: ${finding.detail}`,
    })),
    ...sensitiveReasons(input),
  ];
  const refusals = input.lintCleanup ? lintCleanupRefusals(input) : [];
  const waived = input.lintCleanup && refusals.length === 0 ? waivable : [];
  const reasons: RiskReason[] = [
    ...always,
    ...(waived.length > 0 ? [] : waivable),
    ...refusals.map((refusal) => ({
      key: refusal.key,
      text: `marked as a lint cleanup, but ${refusal.text}`,
    })),
  ];
  return {
    headSha: input.headSha,
    level: reasons.length > 0 ? 'high' : 'low',
    reasons: capped(reasons.map((reason) => reason.text)),
    // Every key, not only those of the reasons shown: a hidden reason is still a reason.
    keys: [...new Set(reasons.map((reason) => reason.key))],
    ...(waived.length > 0 && { waived: capped(waived.map((reason) => reason.text)) }),
  };
}
