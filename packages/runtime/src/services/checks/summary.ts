/**
 * @domain subdomain: Agent Checks
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: domain
 *
 * What `funny_run_checks` answers the agent: the command, exit code,
 * duration, totals and up to `ISSUE_LIMIT` failures as `file:line message`,
 * instead of the full log. The output tail is added only when the run failed
 * without reporting any issue (a crash, a missing tool). The last line is the
 * progress file, which the thread's widget reads.
 */

import type { CheckRunResult } from './runner.js';
import type { CheckPlan } from './toolchain.js';

/** Failures / issues listed; the totals stay exact. */
const ISSUE_LIMIT = 20;
const TAIL_LINES = 15;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const at = (file?: string, line?: number, column?: number) =>
  file
    ? `${file}${line !== undefined ? `:${line}` : ''}${column !== undefined ? `:${column}` : ''}`
    : '';

function testLines(result: CheckRunResult): { lines: string[]; issues: number } {
  if (result.progress.kind !== 'test') return { lines: [], issues: 0 };
  const suites = result.progress.progress.suites;
  const sum = (key: 'passed' | 'failed' | 'skipped') => suites.reduce((n, s) => n + s[key], 0);
  const failures = suites.flatMap((suite) => suite.failures);
  const lines = [
    `Tests: ${sum('passed')} passed, ${sum('failed')} failed, ${sum('skipped')} skipped`,
  ];
  for (const failure of failures.slice(0, ISSUE_LIMIT)) {
    const where = at(failure.file, failure.line);
    lines.push(
      `✗ ${where ? `${where} ` : ''}${failure.name}${failure.message ? ` — ${failure.message}` : ''}`,
    );
  }
  if (failures.length > ISSUE_LIMIT) lines.push(`… ${failures.length - ISSUE_LIMIT} more failures`);
  else if (sum('failed') > failures.length)
    lines.push(`… ${sum('failed') - failures.length} failures without details`);
  return { lines, issues: failures.length };
}

/** ` (812 files, 96 rules)`: what the tool said it checked, when it said. */
function checked(step: { files?: number; lines?: number; rules?: number }): string {
  const parts = [
    step.files !== undefined && `${step.files} files`,
    step.lines !== undefined && `${step.lines} lines`,
    step.rules !== undefined && `${step.rules} rules`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function taskLines(result: CheckRunResult): { lines: string[]; issues: number } {
  if (result.progress.kind !== 'task') return { lines: [], issues: 0 };
  const { steps, issues } = result.progress.progress;
  const lines = steps.map(
    (step) =>
      `${step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '·'} ${step.name}: ${step.errors} errors, ${step.warnings} warnings${checked(step)}`,
  );
  for (const issue of issues.slice(0, ISSUE_LIMIT)) {
    const where = at(issue.file, issue.line, issue.column);
    lines.push(
      `${issue.severity === 'error' ? 'error' : 'warning'} ${where ? `${where} ` : ''}${issue.message}`,
    );
  }
  const total = steps.reduce((n, step) => n + step.errors + step.warnings, 0);
  if (total > Math.min(issues.length, ISSUE_LIMIT))
    lines.push(`… ${total - Math.min(issues.length, ISSUE_LIMIT)} more`);
  return { lines, issues: issues.length };
}

/** The tool result text for a finished run. */
export function summarizeCheckRun(
  plan: CheckPlan,
  result: CheckRunResult,
  progressPath: string,
): string {
  const status = result.stopped
    ? result.stopped === 'timeout'
      ? 'TIMED OUT'
      : 'CANCELLED'
    : result.exitCode === 0
      ? 'PASSED'
      : 'FAILED';
  const commands = plan.steps.map((step) => step.command).join(' ; ');
  const body = plan.progress === 'test' ? testLines(result) : taskLines(result);
  const out = [
    `${plan.kind} ${status} (exit ${result.exitCode}, ${seconds(result.durationMs)})`,
    `$ ${commands}  (in ${plan.cwd})`,
    ...body.lines,
    ...plan.notes.map((note) => `Note: ${note}`),
  ];
  if (result.exitCode !== 0 && body.issues === 0 && result.tail.length) {
    out.push('Output tail:', ...result.tail.slice(-TAIL_LINES).map((line) => `  ${line}`));
  }
  if (result.stopped === 'timeout') out.push('Rerun with background: true for long runs.');
  out.push(`progressPath: ${progressPath}`);
  return out.join('\n');
}
