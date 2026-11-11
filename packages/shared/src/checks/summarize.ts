// Turns the complete output of a finished check into the progress shape its
// widget shows, for checks nobody followed live (a Bash call the agent made
// itself). Returns null unless the output proves what happened: a runner's
// final summary for tests, a reported issue, an exit code or a tool's own
// "nothing found" line for the other kinds. A truncated log stays a plain card.

import {
  TASK_ISSUE_LIMIT,
  TASK_PROGRESS_VERSION,
  type TaskIssue,
  type TaskProgress,
} from '../task-progress.js';
import { TEST_PROGRESS_VERSION, type TestProgress } from '../test-progress.js';
import type { CheckCommand } from './classify.js';
import { createStepParser, type StepReport } from './step-output.js';
import { createOutputParser, suiteFields } from './test-output.js';

export type CheckOutputSummary =
  | { kind: 'test'; progress: TestProgress }
  | { kind: 'task'; progress: TaskProgress };

/** `Exit code N` that Claude's Bash tool puts first in a failed call's output. */
const EXIT_PREFIX = /^Exit code (\d+)\r?\n/;

/** A Bash output's exit code (when it says) and the output without it. */
export function splitExitCode(output: string): { exitCode?: number; output: string } {
  const m = EXIT_PREFIX.exec(output);
  return m ? { exitCode: Number(m[1]), output: output.slice(m[0].length) } : { output };
}

/** How a check is named in its widget: the script, or the tool. */
export function checkLabel(check: CheckCommand): string {
  return check.script ?? check.tool;
}

interface SummarizeOptions {
  exitCode?: number;
  /** When the run ended (epoch ms); the widget shows no duration either way. */
  at?: number;
}

const exitFailed = (exitCode?: number) => exitCode !== undefined && exitCode !== 0;

const runHead = (at: number) => ({ startedAt: at, updatedAt: at, finishedAt: at });

/** A test run: proven only by a runner's final summary. */
function summarizeTests(
  check: CheckCommand,
  lines: string[],
  { exitCode, at }: Required<Pick<SummarizeOptions, 'at'>> & SummarizeOptions,
): CheckOutputSummary | null {
  const parse = createOutputParser(() => at);
  let counts = parse('');
  for (const line of lines) counts = parse(line);
  if (!counts.summarized) return null;
  const status: 'failed' | 'passed' =
    counts.failed > 0 || exitFailed(exitCode) ? 'failed' : 'passed';
  const suite = {
    name: checkLabel(check),
    related: false,
    status,
    ...suiteFields(counts),
    running: [],
  };
  return {
    kind: 'test',
    progress: { version: TEST_PROGRESS_VERSION, status, ...runHead(at), suites: [suite] },
  };
}

/** Every line through the step parser, plus the blank lines a held issue waits for. */
function readSteps(name: string, lines: string[]): { report: StepReport; issues: TaskIssue[] } {
  const parse = createStepParser(name);
  const issues: TaskIssue[] = [];
  let report = parse('').report;
  // A held cargo / ruff / oxlint issue waits up to three lines for its location.
  for (const line of [...lines, '', '', '']) {
    const step = parse(line);
    report = step.report;
    issues.push(...step.issues);
  }
  return { report, issues };
}

/** Any other kind: proven by an issue, an exit code or the tool's "nothing found". */
function summarizeTask(
  check: CheckCommand,
  lines: string[],
  { exitCode, at }: Required<Pick<SummarizeOptions, 'at'>> & SummarizeOptions,
): CheckOutputSummary | null {
  const name = checkLabel(check);
  const { report, issues } = readSteps(name, lines);
  if (issues.length === 0 && exitCode === undefined && !report.clean) return null;
  const failed = report.errors > 0 || exitFailed(exitCode);
  const status: 'failed' | 'passed' = failed ? 'failed' : 'passed';
  const { errors, warnings, unitsDone, unitsTotal, current, tail } = report;
  const step = {
    id: name,
    name,
    status,
    errors,
    warnings,
    unitsDone,
    unitsTotal,
    current,
    tail: failed && errors === 0 ? tail : [],
  };
  const errorsFirst = [
    ...issues.filter((i) => i.severity === 'error'),
    ...issues.filter((i) => i.severity !== 'error'),
  ];
  return {
    kind: 'task',
    progress: {
      version: TASK_PROGRESS_VERSION,
      title: name,
      status,
      ...runHead(at),
      steps: [step],
      issues: errorsFirst.slice(0, TASK_ISSUE_LIMIT),
    },
  };
}

/** The widget progress for a finished check's output, or null when it proves nothing. */
export function summarizeCheckOutput(
  check: CheckCommand,
  output: string,
  { exitCode, at = Date.now() }: SummarizeOptions = {},
): CheckOutputSummary | null {
  const lines = output.split('\n');
  const options = { exitCode, at };
  return check.kind === 'test'
    ? summarizeTests(check, lines, options)
    : summarizeTask(check, lines, options);
}
