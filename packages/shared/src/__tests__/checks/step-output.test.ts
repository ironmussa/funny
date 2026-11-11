import { describe, expect, test } from 'bun:test';

import { createStepParser } from '../../checks/step-output';
import type { TaskIssue } from '../../task-progress';

/** Issues (each tagged with step `lint`) and the final report after feeding a whole output (plus the lines a held issue waits for). */
const feed = (output: string) => {
  const parse = createStepParser('lint');
  const issues: TaskIssue[] = [];
  let report = parse('').report;
  for (const line of [...output.split('\n'), '', '', '']) {
    const step = parse(line);
    report = step.report;
    issues.push(...step.issues);
  }
  return { report, issues };
};

describe('createStepParser formats', () => {
  test('eslint stylish: a file line, then its issues', () => {
    const { report, issues } = feed(
      [
        '/home/u/backend/src/user.entity.ts',
        "  1:68  warning  'ManyToOne' is defined but never used  @typescript-eslint/no-unused-vars",
        '  31:7  error  Unused eslint-disable directive (no problems were reported)',
        '',
        '✖ 2 problems (1 error, 1 warning)',
      ].join('\n'),
    );
    expect(report).toMatchObject({ errors: 1, warnings: 1 });
    expect(issues).toMatchObject([
      {
        severity: 'warning',
        file: '/home/u/backend/src/user.entity.ts',
        line: 1,
        column: 68,
        message: "'ManyToOne' is defined but never used (@typescript-eslint/no-unused-vars)",
      },
      {
        severity: 'error',
        file: '/home/u/backend/src/user.entity.ts',
        line: 31,
        column: 7,
        message: 'Unused eslint-disable directive (no problems were reported)',
      },
    ]);
  });

  test('oxlint default output: ⚠ / × heading, then ╭─[file:line:col]', () => {
    const { report, issues } = feed(
      [
        "  ⚠ eslint(no-unused-vars): Variable 'x' is declared but never used.",
        '   ╭─[src/a.ts:1:7]',
        ' 1 │ const x = 1;',
        '   ╰────',
        '  × eslint(no-debugger): `debugger` statement is not allowed',
        '   ╭─[src/b.ts:3:1]',
        'Found 1 warning and 1 error.',
      ].join('\n'),
    );
    expect(report).toMatchObject({ errors: 1, warnings: 1 });
    expect(issues).toMatchObject([
      {
        severity: 'warning',
        file: 'src/a.ts',
        line: 1,
        column: 7,
        message: "eslint(no-unused-vars): Variable 'x' is declared but never used.",
      },
      {
        severity: 'error',
        file: 'src/b.ts',
        line: 3,
        column: 1,
        message: 'eslint(no-debugger): `debugger` statement is not allowed',
      },
    ]);
  });

  test('tsc --pretty and mypy lines', () => {
    const { issues } = feed(
      [
        'apps/core/test/api.e2e-spec.ts:449:27 - error TS2349: This expression is not callable.',
        'src/relay/recorder.py:572: error: Function is missing a return type annotation  [no-untyped-def]',
        'src/relay/config.py:7: note: See https://mypy.readthedocs.io',
      ].join('\n'),
    );
    expect(issues).toMatchObject([
      {
        severity: 'error',
        file: 'apps/core/test/api.e2e-spec.ts',
        line: 449,
        column: 27,
        message: 'TS2349: This expression is not callable.',
      },
      {
        severity: 'error',
        file: 'src/relay/recorder.py',
        line: 572,
        message: 'Function is missing a return type annotation  [no-untyped-def]',
      },
    ]);
  });

  test('ruff concise and full output', () => {
    const { issues } = feed(
      [
        'src/relay/db.py:31:101: E501 Line too long (108 > 100)',
        'F401 [*] `os` imported but unused',
        ' --> src/relay/main.py:1:8',
      ].join('\n'),
    );
    expect(issues).toMatchObject([
      {
        severity: 'error',
        file: 'src/relay/db.py',
        line: 31,
        column: 101,
        message: 'E501 Line too long (108 > 100)',
      },
      {
        severity: 'error',
        file: 'src/relay/main.py',
        line: 1,
        column: 8,
        message: 'F401 [*] `os` imported but unused',
      },
    ]);
  });

  test('prettier --check lists unformatted files as warnings', () => {
    const { issues } = feed(
      'Checking formatting...\n[warn] src/a.ts\n[warn] Code style issues found in the above file.',
    );
    expect(issues).toMatchObject([
      { severity: 'warning', file: 'src/a.ts', message: 'not formatted' },
    ]);
  });

  test.each([
    'All checks passed!',
    'Success: no issues found in 12 source files',
    'All matched files use Prettier code style!',
    'Found 0 warnings and 0 errors.',
  ])('"%s" marks the step clean', (line) => {
    expect(feed(line).report.clean).toBe(true);
  });
});
