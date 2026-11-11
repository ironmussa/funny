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
import { createStepParser } from './step-output.js';
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

/** The widget progress for a finished check's output, or null when it proves nothing. */
export function summarizeCheckOutput(
  check: CheckCommand,
  output: string,
  { exitCode, at = Date.now() }: SummarizeOptions = {},
): CheckOutputSummary | null {
  const lines = output.split('\n');
  const head = { startedAt: at, updatedAt: at, finishedAt: at };
  if (check.kind === 'test') {
    const parse = createOutputParser(() => at);
    let counts = parse('');
    for (const line of lines) counts = parse(line);
    if (!counts.summarized) return null;
    const failed = counts.failed > 0 || (exitCode !== undefined && exitCode !== 0);
    const status = failed ? 'failed' : 'passed';
    return {
      kind: 'test',
      progress: {
        version: TEST_PROGRESS_VERSION,
        status,
        ...head,
        suites: [
          {
            name: checkLabel(check),
            related: false,
            status,
            ...suiteFields(counts),
            running: [],
          },
        ],
      },
    };
  }

  const name = checkLabel(check);
  const parse = createStepParser(name);
  const issues: TaskIssue[] = [];
  let report = parse('').report;
  for (const line of lines) {
    const step = parse(line);
    report = step.report;
    issues.push(...step.issues);
  }
  // A held cargo / ruff / oxlint issue waits up to three lines for its location.
  for (let i = 0; i < 3; i++) {
    const step = parse('');
    report = step.report;
    issues.push(...step.issues);
  }
  if (issues.length === 0 && exitCode === undefined && !report.clean) return null;

  const failed = report.errors > 0 || (exitCode !== undefined && exitCode !== 0);
  const status = failed ? 'failed' : 'passed';
  const { errors, warnings, unitsDone, unitsTotal, current, tail } = report;
  const counts = { errors, warnings, unitsDone, unitsTotal, current };
  return {
    kind: 'task',
    progress: {
      version: TASK_PROGRESS_VERSION,
      title: name,
      status,
      ...head,
      steps: [
        {
          id: name,
          name,
          status,
          ...counts,
          tail: failed && report.errors === 0 ? tail : [],
        },
      ],
      issues: [
        ...issues.filter((i) => i.severity === 'error'),
        ...issues.filter((i) => i.severity !== 'error'),
      ].slice(0, TASK_ISSUE_LIMIT),
    },
  };
}
