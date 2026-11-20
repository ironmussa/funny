import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { testSuiteEnv } from '../test-env';
import {
  bunTestFlags,
  coveredFiles,
  type ImpactMap,
  isImpactMap,
  loadMap,
  narrowPackage,
  selectTests,
} from '../test-impact';

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

  test('a changed test file the map has never seen selects itself', () => {
    expect(selectTests(map, ['packages/server/src/__tests__/new.test.ts']).tests).toEqual([
      'packages/server/src/__tests__/new.test.ts',
      text,
    ]);
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

describe('narrowPackage', () => {
  let root: string;
  let mapDir: string;
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: root,
      stdout: 'pipe',
      env: testSuiteEnv(process.env),
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return result.stdout.toString().trim();
  };
  const write = (file: string, content = '') => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const commit = (message: string) => {
    run('add', '-A');
    run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const saveMap = (commitSha: string) => {
    const impact: ImpactMap = {
      package: 'packages/server',
      commit: commitSha,
      generatedAt: '',
      tests: {
        'packages/server/src/a.test.ts': ['packages/server/src/a.ts'],
        'packages/server/src/b.test.ts': ['packages/server/src/b.ts'],
      },
      alwaysRun: {},
      durationsMs: {},
    };
    writeFileSync(join(mapDir, 'server.json'), JSON.stringify(impact));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'test-impact-'));
    mapDir = join(root, 'maps');
    mkdirSync(mapDir);
    run('init', '-q');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    run('config', 'commit.gpgsign', 'false');
    for (const file of ['a.ts', 'b.ts', 'a.test.ts', 'b.test.ts'])
      write(`packages/server/src/${file}`);
    write('.gitignore', 'maps/\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('selects the test files of the changed sources, as `./` paths', () => {
    saveMap(commit('base'));
    write('packages/server/src/a.ts', 'changed');
    const head = commit('change a');
    expect(
      narrowPackage('packages/server', ['packages/server/src/a.ts'], [head], { root, mapDir }),
    ).toEqual({ tests: ['./src/a.test.ts'] });
  });

  test('a map built before other changes treats those changes as changed too', () => {
    saveMap(commit('base'));
    write('packages/server/src/b.ts', 'changed earlier');
    commit('change b');
    write('packages/server/src/a.ts', 'changed');
    const head = commit('change a');
    expect(
      narrowPackage('packages/server', ['packages/server/src/a.ts'], [head], { root, mapDir }),
    ).toEqual({ tests: ['./src/a.test.ts', './src/b.test.ts'] });
  });

  test('a map built on a commit the branch does not have still accounts for both sides', () => {
    const base = commit('base');
    run('checkout', '-q', '-b', 'main-later');
    write('packages/server/src/b.ts', 'on main');
    saveMap(commit('main moves on'));
    run('checkout', '-q', base);
    write('packages/server/src/a.ts', 'on branch');
    const head = commit('branch change');
    expect(
      narrowPackage('packages/server', ['packages/server/src/a.ts'], [head], { root, mapDir }),
    ).toEqual({ tests: ['./src/a.test.ts', './src/b.test.ts'] });
  });

  test('a test file deleted since the map is not run', () => {
    saveMap(commit('base'));
    rmSync(join(root, 'packages/server/src/b.test.ts'));
    write('packages/server/src/b.ts', 'changed');
    const head = commit('drop b test');
    expect(
      narrowPackage('packages/server', ['packages/server/src/b.ts'], [head], { root, mapDir }),
    ).toEqual({ tests: [] });
  });

  test('runs whole without a map, with a map from an unknown commit, or with no head', () => {
    const head = commit('base');
    const files = ['packages/server/src/a.ts'];
    expect('whole' in narrowPackage('packages/server', files, [head], { root, mapDir })).toBe(true);
    saveMap('f'.repeat(40));
    expect(narrowPackage('packages/server', files, [head], { root, mapDir })).toEqual({
      whole: 'map commit ffffffff is not local',
    });
    saveMap(head);
    expect('whole' in narrowPackage('packages/server', files, [], { root, mapDir })).toBe(true);
  });

  test('a malformed or foreign map is ignored', () => {
    writeFileSync(join(mapDir, 'server.json'), '{"package": "packages/server"}');
    expect(loadMap('packages/server', mapDir)).toBeNull();
    writeFileSync(join(mapDir, 'server.json'), 'not json');
    expect(loadMap('packages/server', mapDir)).toBeNull();
    saveMap(commit('base'));
    expect(loadMap('packages/other', mapDir)).toBeNull();
    expect(isImpactMap(loadMap('packages/server', mapDir))).toBe(true);
  });
});
