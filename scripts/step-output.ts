// Reads a step's output line by line and pulls out what the task-progress
// widget shows: error and warning counts, the issues themselves (file, line,
// message), sub-unit progress, and what the step reported last.
//
// Understands oxlint (`file:line:col: warning rule: message`), tsc
// (`file(line,col): error TS…: message`), cargo (`error[E…]: message` then
// `--> file:line:col`), funny's typecheck baseline check (`Running bun check
// against 15 projects…`, then one line per project) and the test runner
// (`▶ suite` / `✓ suite 1.2s` / `✗ suite`). Any other line only becomes the
// step's `current` line, and the last few are kept for a step that fails
// without reporting an issue of its own.

import type { TaskIssue } from '../packages/shared/src/task-progress';

// ANSI color/cursor sequences: ESC `[` params final-letter.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Output lines kept for a failed step that reported no issue. */
const TAIL_LINES = 8;
const CURRENT_MAX = 160;

export interface StepReport {
  errors: number;
  warnings: number;
  unitsDone?: number;
  unitsTotal?: number;
  current?: string;
  tail: string[];
}

/** Feeds output lines; returns the report so far and the issues on this line. */
export type StepParser = (line: string) => { report: StepReport; issues: TaskIssue[] };

type Issue = Omit<TaskIssue, 'step'>;

const LOCATED = /^(.+?):(\d+):(\d+): (warning|error) (.+)$/;
const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .+)$/;
const CARGO_HEAD = /^(error|warning)(?:\[\w+\])?: (.+)$/;
const CARGO_AT = /^\s+--> (.+?):(\d+):(\d+)$/;
/** cargo's own summaries, not issues. */
const CARGO_SUMMARY =
  /^(error: (could not compile|aborting due to)|warning: .+ generated \d+ warnings?)/;
const PROJECTS = /^Running bun check against (\d+) projects/;
const PROJECT_DONE = /^\s+(\S+)… \d+ error\(s\)$/;
const SUITE_START = /^▶ (.+)$/;
/** The test runner's `✓ suite 12.3s`; checks' own `✓ message` lines have no time. */
const SUITE_END = /^[✓✗] (\S+) [\d.]+s$/;

const located = (m: RegExpExecArray, at = 1): Issue => ({
  severity: m[at + 3] as Issue['severity'],
  file: m[at],
  line: Number(m[at + 1]),
  column: Number(m[at + 2]),
  message: m[at + 4],
});

/** The issue on a self-contained line (oxlint, tsc), or null. */
function lineIssue(line: string): Issue | null {
  const m = LOCATED.exec(line) ?? TSC.exec(line);
  return m ? located(m) : null;
}

/** Progress lines: typecheck projects, test suites. True when the line was one. */
function progressLine(report: StepReport, line: string): boolean {
  const total = PROJECTS.exec(line);
  if (total) {
    report.unitsTotal = Number(total[1]);
    report.unitsDone = 0;
    return true;
  }
  const done = PROJECT_DONE.exec(line) ?? SUITE_END.exec(line);
  if (done) {
    report.unitsDone = (report.unitsDone ?? 0) + 1;
    report.current = done[1];
    if (line.startsWith('✗')) report.errors++;
    return true;
  }
  const start = SUITE_START.exec(line);
  if (start) report.current = start[1];
  return Boolean(start);
}

export function createStepParser(step: string): StepParser {
  const report: StepReport = { errors: 0, warnings: 0, tail: [] };
  // A cargo issue waits for its `-->` location line.
  let cargo: Issue | null = null;

  const record = (issue: Issue): TaskIssue[] => {
    if (issue.severity === 'error') report.errors++;
    else report.warnings++;
    return [{ step, ...issue }];
  };

  return (raw) => {
    const line = raw.replace(ANSI, '').trimEnd();
    const issues: TaskIssue[] = [];
    const at = cargo && CARGO_AT.exec(line);
    if (cargo && !at) issues.push(...record(cargo)); // cargo prints the location right after
    if (cargo && at) {
      issues.push(...record({ ...cargo, file: at[1], line: Number(at[2]), column: Number(at[3]) }));
    }
    const wasLocation = Boolean(cargo && at);
    cargo = null;
    if (!wasLocation && !progressLine(report, line)) {
      const issue = lineIssue(line);
      const head = !issue && !CARGO_SUMMARY.test(line) && CARGO_HEAD.exec(line);
      if (issue) issues.push(...record(issue));
      else if (head) cargo = { severity: head[1] as Issue['severity'], message: head[2] };
      if (line.trim()) {
        report.current = line.trim().slice(0, CURRENT_MAX);
        report.tail = [...report.tail, report.current].slice(-TAIL_LINES);
      }
    }
    return { report: { ...report }, issues };
  };
}
