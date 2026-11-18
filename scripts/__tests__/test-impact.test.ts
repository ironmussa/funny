import { describe, expect, test } from 'bun:test';

import { bunTestFlags, coveredFiles, type ImpactMap, selectTests } from '../test-impact';

const map: ImpactMap = {
  package: 'packages/server',
  commit: 'abc',
  generatedAt: '2026-11-18T00:00:00.000Z',
  tests: {
    'packages/server/src/__tests__/a.test.ts': [
      'packages/server/src/a.ts',
      'packages/shared/src/util.ts',
    ],
    'packages/server/src/__tests__/b.test.ts': ['packages/server/src/b.ts'],
    'packages/server/src/__tests__/text.test.ts': [],
  },
  alwaysRun: { 'packages/server/src/__tests__/text.test.ts': 'coverage saw no source file' },
  durationsMs: {},
};

describe('coveredFiles', () => {
  test('keeps files with an executed line or function and drops the rest', () => {
    const lcov = [
      'TN:',
      'SF:src/hit.ts',
      'FNF:1',
      'FNH:0',
      'DA:1,0',
      'DA:2,3',
      'end_of_record',
      'TN:',
      'SF:src/missed.ts',
      'FNF:1',
      'FNH:0',
      'DA:1,0',
      'end_of_record',
      'TN:',
      'SF:../shared/src/fn.ts',
      'FNH:1',
      'end_of_record',
    ].join('\n');
    expect(coveredFiles(lcov)).toEqual(['src/hit.ts', '../shared/src/fn.ts']);
  });
});

describe('bunTestFlags', () => {
  test('returns the flags after `bun test`', () => {
    expect(bunTestFlags('bun test --isolate --timeout 20000')).toEqual([
      '--isolate',
      '--timeout',
      '20000',
    ]);
    expect(bunTestFlags('bun test')).toEqual([]);
  });

  test('refuses a script that is not bun test', () => {
    expect(() => bunTestFlags('vitest run')).toThrow();
  });
});

describe('selectTests', () => {
  const text = 'packages/server/src/__tests__/text.test.ts';

  test('selects the tests that executed a changed source, plus the always-run ones', () => {
    expect(selectTests(map, ['packages/shared/src/util.ts'])).toEqual({
      kind: 'some',
      tests: ['packages/server/src/__tests__/a.test.ts', text],
    });
  });

  test('a changed test file selects itself', () => {
    expect(selectTests(map, ['packages/server/src/__tests__/b.test.ts']).tests).toEqual([
      'packages/server/src/__tests__/b.test.ts',
      text,
    ]);
  });

  test('a source no test executed selects only the always-run tests', () => {
    expect(selectTests(map, ['packages/server/src/unused.ts']).tests).toEqual([text]);
  });

  test('a non-code file in the package selects everything', () => {
    const selection = selectTests(map, ['packages/server/bunfig.toml']);
    expect(selection.kind).toBe('all');
    expect(selection.tests).toHaveLength(3);
  });

  test('a test setup file selects everything', () => {
    expect(selectTests(map, ['packages/server/src/__tests__/setup.ts']).kind).toBe('all');
  });

  test('files outside the map select nothing', () => {
    expect(selectTests(map, ['docs/readme.md', 'packages/client/src/x.ts']).tests).toEqual([text]);
  });
});
