/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The test-weakening check (change factory-agent-roles, D6): what a pull
 * request does to the repository's tests and CI, read from its file list and
 * patches without an agent. A finding is a fact about the diff ("a `.skip` was
 * added"), not a judgement: it goes to the reviewer and makes the change high
 * risk, so a person looks before it merges.
 *
 * It errs toward reporting. A test file whose patch GitHub did not give, or a
 * file list that is not whole, is a finding too: what could not be read was
 * not checked.
 */

import type { PullRequestFile, PullRequestFiles } from '@funny/core/github-app';

export type TestWeakeningKind =
  | 'test-file-removed'
  | 'test-case-removed'
  | 'skip-marker'
  | 'focus-marker'
  | 'coverage-threshold'
  | 'ci-workflow'
  | 'test-change-unreadable'
  | 'file-list-truncated';

export interface TestWeakeningFinding {
  kind: TestWeakeningKind;
  /** The file; empty for a finding about the whole change. */
  path: string;
  /** What was found, in one line (a test's name, the marker, the threshold). */
  detail: string;
}

/** At most this many findings are reported per change (the first ones). */
export const MAX_WEAKENING_FINDINGS = 50;

const JS_TEST_FILE = /(^|\/)(__tests__|tests?|specs?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$|(^|\/)tests?\/.*\.py$/;
const GO_TEST_FILE = /_test\.go$/;

export function isTestFile(path: string): boolean {
  return JS_TEST_FILE.test(path) || PY_TEST_FILE.test(path) || GO_TEST_FILE.test(path);
}

const CI_WORKFLOW = /^\.github\/workflows\//;

/** Files that can hold a coverage threshold. */
const COVERAGE_CONFIG =
  /(^|\/)((jest|vitest|vite)\.config\.[cm]?[jt]s|\.nycrc(\.json|\.ya?ml)?|\.c8rc(\.json)?|package\.json|bunfig\.toml|pyproject\.toml|\.coveragerc|setup\.cfg|tox\.ini|\.?codecov\.ya?ml)$/;

/** A line that sets a coverage number: the key, then the number. */
const THRESHOLD_LINE =
  /["']?\b(branches|functions|lines|statements|fail_under|fail-under|coverageThreshold|threshold|target|perFile)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/;

/** The declaration of a test or suite, capturing its title. */
const JS_TEST_DECLARATION =
  /\b(?:it|test|describe)(?:\.(?:each|concurrent|serial|skip|only|todo|skipIf|if))*\s*(?:\([^)]*\)\s*)?\(\s*(['"`])(.+?)\1/;
const PY_TEST_DECLARATION = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/;
const GO_TEST_DECLARATION = /^\s*func\s+(Test\w+)\s*\(/;

const JS_SKIP = /\b(?:it|test|describe)\.(?:skip|todo|skipIf)\b|\b(?:xit|xtest|xdescribe)\s*\(/;
const JS_FOCUS = /\b(?:it|test|describe)\.only\b|\b(?:fit|fdescribe)\s*\(/;
const PY_SKIP =
  /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/;
const GO_SKIP = /\bt\.Skip(?:f|Now)?\s*\(/;

/** The added (`+`) and removed (`-`) lines of a unified diff, without their marker. */
function changedLines(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

function testTitle(line: string): string | null {
  const js = JS_TEST_DECLARATION.exec(line);
  if (js?.[2]) return js[2];
  return PY_TEST_DECLARATION.exec(line)?.[1] ?? GO_TEST_DECLARATION.exec(line)?.[1] ?? null;
}

const short = (text: string) => {
  const line = text.trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/** Tests whose declaration was removed and does not come back in the same file. */
function removedTests(path: string, added: string[], removed: string[]): TestWeakeningFinding[] {
  const kept = new Set(added.flatMap((line) => testTitle(line) ?? []));
  const gone = new Set<string>();
  for (const line of removed) {
    const title = testTitle(line);
    if (title !== null && !kept.has(title)) gone.add(title);
  }
  return [...gone].map((title) => ({ kind: 'test-case-removed', path, detail: short(title) }));
}

function markers(path: string, added: string[]): TestWeakeningFinding[] {
  const findings: TestWeakeningFinding[] = [];
  for (const line of added) {
    if (JS_SKIP.test(line) || PY_SKIP.test(line) || GO_SKIP.test(line)) {
      findings.push({ kind: 'skip-marker', path, detail: short(line) });
    } else if (JS_FOCUS.test(line)) {
      findings.push({ kind: 'focus-marker', path, detail: short(line) });
    }
  }
  return findings;
}

function thresholdsOf(lines: string[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const line of lines) {
    const match = THRESHOLD_LINE.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    found.set(match[1], [...(found.get(match[1]) ?? []), Number(match[2])]);
  }
  return found;
}

/**
 * Coverage numbers that went down or away: for each key, the removed values
 * are paired in order with the added ones; a lower added value, or no added
 * value at all, is a finding.
 */
function loweredThresholds(
  path: string,
  added: string[],
  removed: string[],
): TestWeakeningFinding[] {
  const before = thresholdsOf(removed);
  const after = thresholdsOf(added);
  const findings: TestWeakeningFinding[] = [];
  for (const [key, values] of before) {
    const next = after.get(key) ?? [];
    values.forEach((value, index) => {
      const now = next[index];
      if (now === undefined) {
        findings.push({ kind: 'coverage-threshold', path, detail: `${key} ${value} removed` });
      } else if (now < value) {
        findings.push({ kind: 'coverage-threshold', path, detail: `${key} ${value} → ${now}` });
      }
    });
  }
  return findings;
}

function fileFindings(file: PullRequestFile): TestWeakeningFinding[] {
  const findings: TestWeakeningFinding[] = [];
  const path = file.path;
  const before = file.previousPath ?? path;
  if (CI_WORKFLOW.test(path) || CI_WORKFLOW.test(before)) {
    findings.push({ kind: 'ci-workflow', path, detail: `${file.status} CI workflow` });
  }
  const wasTest = isTestFile(before);
  const isTest = isTestFile(path);
  if (wasTest && (file.status === 'removed' || !isTest)) {
    // Deleted, or renamed to a path no test runner picks up.
    findings.push({
      kind: 'test-file-removed',
      path: before,
      detail: file.status === 'removed' ? 'test file deleted' : `renamed to ${path}`,
    });
    return findings;
  }
  const config = COVERAGE_CONFIG.test(path);
  if (!isTest && !config) return findings;
  if (file.patch === undefined) {
    // Nothing to read: a rename without changes is fine, anything else was not checked.
    if (isTest && file.additions + file.deletions > 0) {
      findings.push({
        kind: 'test-change-unreadable',
        path,
        detail: 'GitHub gave no diff for this test file',
      });
    }
    return findings;
  }
  const { added, removed } = changedLines(file.patch);
  if (isTest) findings.push(...removedTests(path, added, removed), ...markers(path, added));
  if (config) findings.push(...loweredThresholds(path, added, removed));
  return findings;
}

/** What the change does to the tests and CI, in file order, the first `MAX_WEAKENING_FINDINGS`. */
export function checkTestWeakening(change: PullRequestFiles): TestWeakeningFinding[] {
  const findings: TestWeakeningFinding[] = change.truncated
    ? [
        {
          kind: 'file-list-truncated',
          path: '',
          detail: 'the change has more files than were read',
        },
      ]
    : [];
  for (const file of change.files) findings.push(...fileFindings(file));
  return findings.slice(0, MAX_WEAKENING_FINDINGS);
}

/** The report as the reviewer's prompt carries it: one line per finding, or that there is none. */
export function testWeakeningReport(findings: readonly TestWeakeningFinding[]): string {
  if (findings.length === 0) return 'No weakened test, skipped test or CI workflow edit was found.';
  return findings
    .map(
      (finding) =>
        `- ${finding.kind}${finding.path ? ` in ${finding.path}` : ''}: ${finding.detail}`,
    )
    .join('\n');
}
