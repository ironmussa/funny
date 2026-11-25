import { describe, expect, test } from 'bun:test';

import type { PullRequestFile } from '@funny/core/github-app';

import { classifyRisk, MAX_LOW_RISK_LINES } from '../../../services/factory/factory-risk.js';
import {
  checkTestWeakening,
  isTestFile,
  testWeakeningReport,
} from '../../../services/factory/factory-test-weakening.js';

const SHA = 'd'.repeat(40);

/** A modified file whose patch has these `+` / `-` lines. */
function file(path: string, lines: string[], over: Partial<PullRequestFile> = {}): PullRequestFile {
  return {
    path,
    status: 'modified',
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    patch: ['@@ -1,3 +1,3 @@', ...lines].join('\n'),
    ...over,
  };
}

const check = (...files: PullRequestFile[]) => checkTestWeakening({ files, truncated: false });

describe('isTestFile', () => {
  test('knows test files of TS/JS, Python and Go', () => {
    for (const path of [
      'src/a.test.ts',
      'src/a.spec.tsx',
      'packages/x/src/__tests__/a.ts',
      'e2e/login.ts',
      'tests/test_api.py',
      'pkg/api_test.py',
      'pkg/server_test.go',
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of ['src/a.ts', 'src/contest.ts', 'docs/testing.md', 'src/latest/a.py']) {
      expect(isTestFile(path)).toBe(false);
    }
  });
});

describe('checkTestWeakening', () => {
  test('a clean diff has no finding', () => {
    const findings = check(
      file('src/sum.ts', ['-return a - b;', '+return a + b;']),
      file('src/sum.test.ts', ["+test('adds', () => {", '+  expect(sum(1, 2)).toBe(3);', '+});']),
    );
    expect(findings).toEqual([]);
    expect(testWeakeningReport(findings)).toContain('No weakened test');
  });

  test('a deleted test file', () => {
    expect(
      check(file('src/sum.test.ts', ["-test('adds', () => {});"], { status: 'removed' })),
    ).toEqual([
      { kind: 'test-file-removed', path: 'src/sum.test.ts', detail: 'test file deleted' },
    ]);
  });

  test('a test file renamed to a path no runner picks up', () => {
    const renamed = file('src/sum.disabled.ts', [], {
      status: 'renamed',
      previousPath: 'src/sum.test.ts',
    });
    expect(check(renamed)).toEqual([
      {
        kind: 'test-file-removed',
        path: 'src/sum.test.ts',
        detail: 'renamed to src/sum.disabled.ts',
      },
    ]);
  });

  test('a removed test case, but not a renamed-in-place or edited one', () => {
    const findings = check(
      file('src/sum.test.ts', [
        "-test('adds negative numbers', () => {",
        '-  expect(sum(-1, -2)).toBe(-3);',
        '-});',
        "-test('adds', () => {",
        "+test('adds', async () => {",
      ]),
    );
    expect(findings).toEqual([
      { kind: 'test-case-removed', path: 'src/sum.test.ts', detail: 'adds negative numbers' },
    ]);
  });

  // test-funny PR #54: an agent renamed a test along with the behaviour it checks,
  // and the run was held as "high risk" for a test it never removed.
  test('a test renamed in place is not a removed test', () => {
    const findings = check(
      file('src/greet.test.js', [
        "-test('greet returns Hello message with name', () => {",
        "-  assert.strictEqual(greet('World'), 'Hello, World!');",
        "+test('greet returns Hi message with name', () => {",
        "+  assert.strictEqual(greet('World'), 'Hi, World!');",
      ]),
    );
    expect(findings).toEqual([]);
    const change = { files: [], truncated: false };
    expect(classifyRisk({ headSha: SHA, change, findings }).level).toBe('low');
  });

  test('more tests gone than renamed: every title that went is named', () => {
    const findings = check(
      file('src/sum.test.ts', [
        "-test('adds', () => {",
        "-test('adds negative numbers', () => {",
        "+test('sums', () => {",
      ]),
    );
    expect(findings).toEqual([
      { kind: 'test-case-removed', path: 'src/sum.test.ts', detail: 'adds' },
      { kind: 'test-case-removed', path: 'src/sum.test.ts', detail: 'adds negative numbers' },
    ]);
  });

  test('a removed Python test function', () => {
    expect(
      check(file('tests/test_api.py', ['-def test_rejects_bad_token():', '-    assert 1'])),
    ).toEqual([
      { kind: 'test-case-removed', path: 'tests/test_api.py', detail: 'test_rejects_bad_token' },
    ]);
  });

  test('skip markers in TS/JS', () => {
    const findings = check(
      file('src/a.test.ts', [
        "+test.skip('adds', () => {});",
        "+xit('subtracts', () => {});",
        "+describe.skip('suite', () => {});",
        "+it.todo('later');",
      ]),
    );
    expect(findings.map((finding) => finding.kind)).toEqual([
      'skip-marker',
      'skip-marker',
      'skip-marker',
      'skip-marker',
    ]);
    expect(findings[0]?.detail).toBe("test.skip('adds', () => {});");
  });

  test('a focus marker', () => {
    expect(check(file('src/a.test.ts', ["+test.only('adds', () => {});"]))).toEqual([
      { kind: 'focus-marker', path: 'src/a.test.ts', detail: "test.only('adds', () => {});" },
    ]);
  });

  test('skip markers in Python', () => {
    const findings = check(
      file('tests/test_api.py', [
        '+@pytest.mark.skip(reason="flaky")',
        '+@pytest.mark.xfail',
        '+    pytest.skip("later")',
      ]),
    );
    expect(findings.map((finding) => finding.kind)).toEqual([
      'skip-marker',
      'skip-marker',
      'skip-marker',
    ]);
  });

  test('a skip marker outside a test file is not reported', () => {
    expect(
      check(file('src/queue.ts', ['+  queue.skip(next);', "+const only = 'it.only';"])),
    ).toEqual([]);
  });

  test('a removed skip marker is not a finding', () => {
    expect(
      check(file('src/a.test.ts', ["-test.skip('adds', () => {});", "+test('adds', () => {});"])),
    ).toEqual([]);
  });

  test('a lowered coverage threshold, and a removed one', () => {
    const findings = check(
      file('vitest.config.ts', [
        '-      lines: 80,',
        '+      lines: 60,',
        '-      branches: 70,',
        '-      functions: 75,',
        '+      functions: 90,',
      ]),
      file('pyproject.toml', ['-fail_under = 90', '+fail_under = 50']),
    );
    expect(findings).toEqual([
      { kind: 'coverage-threshold', path: 'vitest.config.ts', detail: 'lines 80 → 60' },
      { kind: 'coverage-threshold', path: 'vitest.config.ts', detail: 'branches 70 removed' },
      { kind: 'coverage-threshold', path: 'pyproject.toml', detail: 'fail_under 90 → 50' },
    ]);
  });

  test('a threshold in a file that is not a coverage config is not reported', () => {
    expect(check(file('src/chart.ts', ['-  lines: 80,', '+  lines: 60,']))).toEqual([]);
  });

  test('an edited CI workflow', () => {
    expect(
      check(file('.github/workflows/ci.yml', ['-      - run: bun test', '+      - run: true'])),
    ).toEqual([
      { kind: 'ci-workflow', path: '.github/workflows/ci.yml', detail: 'modified CI workflow' },
    ]);
  });

  test('a test file GitHub gave no diff for', () => {
    const big = file('src/a.test.ts', [], { patch: undefined, additions: 900, deletions: 400 });
    expect(check(big)).toEqual([
      {
        kind: 'test-change-unreadable',
        path: 'src/a.test.ts',
        detail: 'GitHub gave no diff for this test file',
      },
    ]);
  });

  test('a file list that is not whole', () => {
    expect(checkTestWeakening({ files: [], truncated: true })).toEqual([
      {
        kind: 'file-list-truncated',
        path: '',
        detail: 'the change has more files than were read',
      },
    ]);
  });
});

describe('classifyRisk', () => {
  const risk = (
    files: PullRequestFile[],
    over: {
      sensitivePaths?: string[];
      riskHints?: string[];
      maxLowRiskLines?: number;
      sizeIgnoredPaths?: string[];
      lintCleanup?: boolean;
    } = {},
  ) => {
    const change = { files, truncated: false };
    return classifyRisk({ headSha: SHA, change, findings: checkTestWeakening(change), ...over });
  };

  test('a small change in ordinary code is low risk', () => {
    const sixty = Array.from({ length: 60 }, (_, index) => `+const v${index} = ${index};`);
    expect(risk([file('src/sum.ts', sixty)])).toEqual({
      headSha: SHA,
      level: 'low',
      reasons: [],
      keys: [],
    });
  });

  test('a weakened test makes it high', () => {
    const result = risk([file('src/a.test.ts', ["+test.skip('adds', () => {});"])]);
    expect(result.level).toBe('high');
    expect(result.reasons).toEqual(["skip-marker in src/a.test.ts: test.skip('adds', () => {});"]);
  });

  test('more than the line limit makes it high; exactly the limit does not', () => {
    const sized = (lines: number) =>
      risk([file('src/big.ts', [], { additions: lines, deletions: 0 })]);
    expect(sized(MAX_LOW_RISK_LINES).level).toBe('low');
    expect(sized(MAX_LOW_RISK_LINES + 1)).toMatchObject({
      level: 'high',
      reasons: ['401 changed lines outside tests and docs (more than 400)'],
    });
  });

  test('a lockfile does not count toward the size', () => {
    const result = risk([
      file('bun.lock', [], { additions: 5000, deletions: 4000 }),
      file('src/a.ts', ['+const a = 1;']),
    ]);
    expect(result.level).toBe('low');
  });

  test('tests, Markdown, translations, stories and snapshots do not count toward the size', () => {
    const big = { additions: 5000, deletions: 0 };
    const result = risk([
      file('src/__tests__/a.test.ts', [], big),
      file('docs/guide.md', [], big),
      file('CLAUDE.md', [], big),
      file('packages/client/src/locales/es/translation.json', [], big),
      file('src/Button.stories.tsx', [], big),
      file('src/__snapshots__/a.snap', [], big),
      file('src/a.ts', [], { additions: MAX_LOW_RISK_LINES, deletions: 0 }),
    ]);
    expect(result).toEqual({ headSha: SHA, level: 'low', reasons: [], keys: [] });
  });

  test('only the counted files add up to the size', () => {
    const result = risk([
      file('src/a.test.ts', [], { additions: 900, deletions: 0 }),
      file('README.md', [], { additions: 900, deletions: 0 }),
      file('src/a.ts', [], { additions: 300, deletions: 0 }),
      file('package.json', [], { additions: 101, deletions: 0 }),
    ]);
    expect(result.reasons).toEqual(['401 changed lines outside tests and docs (more than 400)']);
  });

  test("the factory's own line limit replaces the default one", () => {
    const change = [file('src/big.ts', [], { additions: 150, deletions: 0 })];
    expect(risk(change).level).toBe('low');
    expect(risk(change, { maxLowRiskLines: 100 })).toMatchObject({
      level: 'high',
      reasons: ['150 changed lines outside tests and docs (more than 100)'],
    });
    const huge = [file('src/big.ts', [], { additions: 900, deletions: 0 })];
    expect(risk(huge, { maxLowRiskLines: 1000 }).level).toBe('low');
  });

  test("the factory's ignored globs leave their files out of the size, not out of sensitive paths", () => {
    const change = [
      file('src/generated/api.ts', [], { additions: 3000, deletions: 0 }),
      file('src/a.ts', ['+const a = 1;']),
    ];
    expect(risk(change).level).toBe('high');
    expect(risk(change, { sizeIgnoredPaths: ['**/generated/**'] }).level).toBe('low');
    const sensitive = [file('src/auth/generated/keys.ts', [], { additions: 3000, deletions: 0 })];
    expect(risk(sensitive, { sizeIgnoredPaths: ['**/generated/**'] })).toMatchObject({
      level: 'high',
      reasons: ['touches a sensitive path: src/auth/generated/keys.ts (**/auth/**)'],
    });
  });

  test('a sensitive path still counts in a file left out of the size', () => {
    expect(risk([file('.github/CONTRIBUTING.md', ['+hello'])]).level).toBe('high');
  });

  test('a default sensitive path makes it high', () => {
    for (const path of [
      '.github/CODEOWNERS',
      'packages/server/src/db/migrate.ts',
      'db/migrations/007_users.sql',
      'packages/server/src/auth/session.ts',
    ]) {
      const result = risk([file(path, ['+x'])]);
      expect(result.level).toBe('high');
      expect(result.reasons.some((reason) => reason.includes(path))).toBe(true);
    }
  });

  test("the factory's own sensitive path makes it high", () => {
    expect(risk([file('billing/invoice.ts', ['+x'])]).level).toBe('low');
    expect(
      risk([file('billing/invoice.ts', ['+x'])], { sensitivePaths: ['billing/**'] }),
    ).toMatchObject({
      level: 'high',
      reasons: ['touches a sensitive path: billing/invoice.ts (billing/**)'],
    });
  });

  test('a file moved out of a sensitive path still counts', () => {
    const moved = file('src/session.ts', [], {
      status: 'renamed',
      previousPath: 'src/auth/session.ts',
    });
    expect(risk([moved]).level).toBe('high');
  });

  test('a risk hint of the contract makes it high; a run without a contract has none', () => {
    const change = [file('src/a.ts', ['+x'])];
    expect(risk(change).level).toBe('low');
    expect(risk(change, { riskHints: ['changes the retry policy'] })).toMatchObject({
      level: 'high',
      reasons: ['the contract names a risk: changes the retry policy'],
    });
  });

  // A member marked the run as a lint cleanup: large changes that only clear
  // warnings pass, as long as the diff shows the warnings were not hidden.
  describe('a run a member marked as a lint cleanup', () => {
    const big = Array.from({ length: 900 }, (_, index) => `+const v${index} = ${index};`);
    const hints = { riskHints: ['Large mechanical change: expect conflicts'] };
    // Built in two parts: this file's own audit reads a literal skip as a weakened test.
    const SKIPPED_TEST = ['+test', ".skip('adds', () => {"].join('');

    test('its size and the contract hints do not make it high risk, and are kept as waived', () => {
      const marked = risk([file('src/long.ts', big)], { ...hints, lintCleanup: true });
      expect(marked).toMatchObject({ level: 'low', reasons: [], keys: [] });
      expect(marked.waived).toEqual([
        '900 changed lines outside tests and docs (more than 400)',
        'the contract names a risk: Large mechanical change: expect conflicts',
      ]);
      // Unmarked, the same change waits for a person.
      expect(risk([file('src/long.ts', big)], hints).level).toBe('high');
    });

    test('a sensitive path and a weakened test still make it high risk', () => {
      const sensitive = risk([file('src/long.ts', big), file('src/db/migrate.ts', ['+x'])], {
        lintCleanup: true,
      });
      expect(sensitive.level).toBe('high');
      expect(sensitive.reasons).toEqual([
        'touches a sensitive path: src/db/migrate.ts (**/migrate.ts)',
      ]);
      const skipped = risk([file('src/long.ts', big), file('src/sum.test.ts', [SKIPPED_TEST])], {
        lintCleanup: true,
      });
      expect(skipped.level).toBe('high');
      expect(skipped.keys?.some((key) => key.startsWith('finding:'))).toBe(true);
    });

    test('a suppression added to clear a warning is not a cleanup: the size counts again', () => {
      const silenced = risk(
        [file('src/long.ts', [...big, '+// eslint-disable-next-line max-lines'])],
        { lintCleanup: true },
      );
      expect(silenced.level).toBe('high');
      expect(silenced.waived).toBeUndefined();
      expect(silenced.reasons).toEqual([
        '901 changed lines outside tests and docs (more than 400)',
        'marked as a lint cleanup, but it adds a lint or type-check suppression (src/long.ts)',
      ]);
      expect(silenced.keys).toContain('lint-cleanup:suppression');
    });

    test('a change to the lint configuration is not a cleanup', () => {
      const loosened = risk([file('src/long.ts', big), file('oxlint.config.ts', ['+x'])], {
        lintCleanup: true,
      });
      expect(loosened.level).toBe('high');
      expect(loosened.reasons.at(-1)).toBe(
        'marked as a lint cleanup, but it changes the lint or type-check configuration (oxlint.config.ts)',
      );
    });

    test('a file GitHub gave no diff for cannot be checked, so nothing is waived', () => {
      const unread = classifyRisk({
        headSha: SHA,
        change: {
          files: [{ path: 'src/huge.ts', status: 'modified', additions: 900, deletions: 0 }],
          truncated: false,
        },
        findings: [],
        lintCleanup: true,
      });
      expect(unread.level).toBe('high');
      expect(unread.keys).toEqual(['size', 'lint-cleanup:unread']);
    });

    test('a small marked change with nothing to waive reads as any low-risk change', () => {
      const small = risk([file('src/a.ts', ['+const a = 1;'])], { lintCleanup: true });
      expect(small).toEqual({ headSha: SHA, level: 'low', reasons: [], keys: [] });
    });
  });

  test('a review result is not an input: a passing review cannot lower the class', () => {
    // The classifier takes the diff, the findings, the settings and the contract's hints only.
    const input = {
      headSha: SHA,
      change: { files: [file('.github/workflows/ci.yml', ['+x'])], truncated: false },
      findings: [],
      review: { verdict: 'pass', risk: 'low' },
    };
    expect(classifyRisk(input).level).toBe('high');
  });

  // openspec factory-approval-survives-integration, D4: a merge approval
  // follows a small adjustment only to a commit with no risk key the approved
  // one lacked, so a key says what a reason is about and leaves its numbers out.
  describe('the stable keys of the reasons', () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `+const v${i} = ${i};`);

    test('a change over the size limit that grows keeps the key `size`', () => {
      const before = risk([file('src/sum.ts', lines(500))]);
      const after = risk([file('src/sum.ts', lines(520))]);
      expect(before.reasons).not.toEqual(after.reasons);
      expect(before.keys).toEqual(['size']);
      expect(after.keys).toEqual(['size']);
    });

    test('a sensitive path, a finding and a contract hint each add a key', () => {
      const result = risk(
        [
          file('src/sum.ts', ['+x']),
          file('packages/server/src/db/migrate.ts', ['+x']),
          file('src/a.test.ts', ["+test.skip('adds', () => {});"]),
        ],
        { riskHints: ['touches billing'] },
      );
      expect(result.keys).toContain('sensitive:packages/server/src/db/migrate.ts');
      expect(
        result.keys?.some((key) => key.startsWith('finding:') && key.endsWith('src/a.test.ts')),
      ).toBe(true);
      expect(result.keys?.filter((key) => key.startsWith('contract:'))).toHaveLength(1);
      // The same hint is the same key; another hint is another.
      const same = risk([file('src/sum.ts', ['+x'])], { riskHints: ['touches billing'] });
      const other = risk([file('src/sum.ts', ['+x'])], { riskHints: ['touches auth'] });
      expect(result.keys).toContain(same.keys![0]!);
      expect(other.keys).not.toEqual(same.keys);
    });

    test('every reason has its key, also the ones the capped list does not show', () => {
      const many = Array.from({ length: 30 }, (_, index) => file(`src/auth/f${index}.ts`, ['+x']));
      expect(risk(many).keys).toHaveLength(30);
    });
  });

  test('many reasons are capped with a count', () => {
    const many = Array.from({ length: 30 }, (_, index) => file(`src/auth/f${index}.ts`, ['+x']));
    const result = risk(many);
    expect(result.reasons).toHaveLength(12);
    expect(result.reasons.at(-1)).toBe('and 19 more');
  });
});
