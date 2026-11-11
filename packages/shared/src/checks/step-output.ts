// Reads a step's output line by line and pulls out what the task-progress
// widget shows: error and warning counts, the issues themselves (file, line,
// message), sub-unit progress, and what the step reported last.
//
// Understands oxlint (`file:line:col: warning rule: message`, and its default
// `⚠ rule: message` then `╭─[file:line:col]`), eslint's stylish output (a file
// line, then `  12:5  error  message  rule`), tsc (`file(line,col): error TS…:
// message`, or `file:line:col - error TS…` with --pretty), mypy (`file:line:
// error: message`), ruff (`file:line:col: F401 message`, or `F401 message`
// then `--> file:line:col`), prettier --check (`[warn] file`), cargo
// (`error[E…]: message` then `--> file:line:col`), funny's typecheck baseline check (`Running bun check
// against 15 projects…`, then one line per project) and the test runner
// (`▶ suite` / `✓ suite 1.2s` / `✗ suite`). Any other line only becomes the
// step's `current` line, and the last few are kept for a step that fails
// without reporting an issue of its own.

import type { TaskIssue } from '../task-progress.js';
import { cleanLine } from './text.js';

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
  /** The tool said it found nothing (`All checks passed!`, `Found 0 warnings…`). */
  clean?: boolean;
}

/** Feeds output lines; returns the report so far and the issues on this line. */
export type StepParser = (line: string) => { report: StepReport; issues: TaskIssue[] };

type Issue = Omit<TaskIssue, 'step'>;

const LOCATED = /^(.+?):(\d+):(\d+): (warning|error) (.+)$/;
const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .+)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+: .+)$/;
const MYPY = /^(.+?\.pyi?):(\d+)(?::(\d+))?: (error|warning): (.+)$/;
const RUFF = /^(.+?\.pyi?):(\d+):(\d+): ([A-Z]+\d+ .+)$/;
const PRETTIER = /^\[warn\] (\S+\.\w+)$/;
/** eslint stylish: a file on its own line, then indented `line:col  severity  message  rule`. */
const STYLISH_FILE = /^((?:[A-Za-z]:)?[/\\.]?[^\s:]+\.\w+)$/;
const STYLISH_ISSUE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;
/** Issues whose location comes on a later line: cargo, ruff's full output, oxlint's default. */
const CARGO_HEAD = /^(error|warning)(?:\[\w+\])?: (.+)$/;
const RUFF_HEAD = /^([A-Z]{1,4}\d{2,4}) (.+)$/;
const OXLINT_HEAD = /^\s*([⚠×!x])\s+(\S+\(\S+\): .+)$/;
const CARGO_AT = /^\s*--> (.+?):(\d+):(\d+)$/;
const OXLINT_AT = /^\s*╭─\[(.+?):(\d+):(\d+)\]$/;
/** What tools print when they found nothing to report. */
const CLEAN =
  /^(All checks passed!|Success: no issues found|All matched files use Prettier code style!|Found 0 warnings and 0 errors\.?|Checked \d+ files? in .+\. No fixes (?:applied|needed)\.?)/;
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

/** The issue on a self-contained line (oxlint, tsc, mypy, ruff, prettier), or null. */
function lineIssue(line: string): Issue | null {
  const m = LOCATED.exec(line) ?? TSC.exec(line) ?? TSC_PRETTY.exec(line);
  if (m) return located(m);
  const mypy = MYPY.exec(line);
  if (mypy) {
    return {
      severity: mypy[4] as Issue['severity'],
      file: mypy[1],
      line: Number(mypy[2]),
      ...(mypy[3] ? { column: Number(mypy[3]) } : {}),
      message: mypy[5],
    };
  }
  const ruff = RUFF.exec(line);
  if (ruff) {
    return {
      severity: 'error',
      file: ruff[1],
      line: Number(ruff[2]),
      column: Number(ruff[3]),
      message: ruff[4],
    };
  }
  const prettier = PRETTIER.exec(line);
  return prettier ? { severity: 'warning', file: prettier[1], message: 'not formatted' } : null;
}

/** An issue whose location is on a later line, or null. */
function headIssue(line: string): Issue | null {
  if (CARGO_SUMMARY.test(line)) return null;
  const cargo = CARGO_HEAD.exec(line);
  if (cargo) return { severity: cargo[1] as Issue['severity'], message: cargo[2] };
  const oxlint = OXLINT_HEAD.exec(line);
  if (oxlint) return { severity: oxlint[1] === '⚠' ? 'warning' : 'error', message: oxlint[2] };
  const ruff = RUFF_HEAD.exec(line);
  return ruff ? { severity: 'error', message: line } : null;
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
  // A cargo / ruff / oxlint issue waits for its location line, a few lines on.
  let headed: { issue: Issue; linesLeft: number } | null = null;
  // The file eslint's stylish output is listing issues for.
  let stylishFile: string | null = null;

  const record = (issue: Issue): TaskIssue[] => {
    if (issue.severity === 'error') report.errors++;
    else report.warnings++;
    return [{ step, ...issue }];
  };

  // An issue's location comes on one of the next lines (cargo and ruff right
  // after it, oxlint after a blank line): `consumed` tells whether `line` was it.
  const flushHeaded = (line: string): { issues: TaskIssue[]; consumed: boolean } => {
    if (!headed) return { issues: [], consumed: false };
    const at = CARGO_AT.exec(line) ?? OXLINT_AT.exec(line);
    if (at) {
      const { issue } = headed;
      headed = null;
      return {
        issues: record({ ...issue, file: at[1], line: Number(at[2]), column: Number(at[3]) }),
        consumed: true,
      };
    }
    if (--headed.linesLeft > 0 && !line.trim()) return { issues: [], consumed: false };
    const { issue } = headed;
    headed = null;
    return { issues: record(issue), consumed: false };
  };

  const stylish = (line: string): TaskIssue[] | null => {
    const file = STYLISH_FILE.exec(line);
    if (file) {
      stylishFile = file[1];
      return null;
    }
    const m = stylishFile ? STYLISH_ISSUE.exec(line) : null;
    if (!m) return null;
    const message = m[5] ? `${m[4]} (${m[5]})` : m[4];
    const severity = m[3] as Issue['severity'];
    return record({
      severity,
      file: stylishFile!,
      line: Number(m[1]),
      column: Number(m[2]),
      message,
    });
  };

  /** The issues a line reports itself, or starts (held until its location). */
  const issuesOf = (line: string): TaskIssue[] => {
    const issue = lineIssue(line);
    if (issue) return record(issue);
    const fromStylish = stylish(line);
    if (fromStylish) return fromStylish;
    const head = headIssue(line);
    if (head) headed = { issue: head, linesLeft: 3 };
    return [];
  };

  const remember = (line: string) => {
    const text = line.trim();
    if (CLEAN.test(text)) report.clean = true;
    if (!text) return;
    report.current = text.slice(0, CURRENT_MAX);
    report.tail = [...report.tail, report.current].slice(-TAIL_LINES);
  };

  const readLine = (line: string): TaskIssue[] => {
    if (progressLine(report, line)) return [];
    remember(line);
    return issuesOf(line);
  };

  return (raw) => {
    const line = cleanLine(raw);
    const { issues, consumed } = flushHeaded(line);
    if (!consumed) issues.push(...readLine(line));
    return { report: { ...report }, issues };
  };
}
