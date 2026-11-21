import { describe, expect, test } from 'bun:test';

import { isSearchCommand, parseSearchOutput } from '@/components/tool-cards/search-output';

describe('isSearchCommand', () => {
  test('recognizes rg, grep and git grep anywhere in a pipeline', () => {
    expect(isSearchCommand('cd /tmp/x; rg -ln "foo" src')).toBe(true);
    expect(isSearchCommand('cat a.txt | grep -n bar')).toBe(true);
    expect(isSearchCommand('git grep -n baz')).toBe(true);
    expect(isSearchCommand('bun test')).toBe(false);
    expect(isSearchCommand('echo grepping')).toBe(false);
  });
});

describe('parseSearchOutput', () => {
  test('groups path:line:text matches by file and keeps path-only lines and notes', () => {
    const output = [
      'core/src/__tests__/github-app-pull-requests.test.ts',
      'core/src/__tests__/github-app-pull-requests.test.ts:44:    const lint = { id: 2 };',
      "core/src/__tests__/github-app-pull-requests.test.ts:88:            conclusion: 'failure',",
      'server/src/__tests__/services/factory/factory-ci-actions.test.ts',
      'Shell cwd was reset to /home/me/project',
    ].join('\n');

    expect(parseSearchOutput(output)).toEqual([
      {
        kind: 'file',
        path: 'core/src/__tests__/github-app-pull-requests.test.ts',
        matches: [
          { line: 44, text: 'const lint = { id: 2 };' },
          { line: 88, text: "conclusion: 'failure'," },
        ],
      },
      {
        kind: 'file',
        path: 'server/src/__tests__/services/factory/factory-ci-actions.test.ts',
        matches: [],
      },
      { kind: 'note', text: 'Shell cwd was reset to /home/me/project' },
    ]);
  });

  test('reads line-only matches from a single-file search', () => {
    expect(parseSearchOutput('12:foo\n30:  bar')).toEqual([
      {
        kind: 'matches',
        matches: [
          { line: 12, text: 'foo' },
          { line: 30, text: 'bar' },
        ],
      },
    ]);
  });

  test('returns null when nothing reads as a search result', () => {
    expect(parseSearchOutput('error: unrecognized flag --foo\nUsage: rg [OPTIONS]')).toBeNull();
  });
});
