import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverPackages,
  type Narrowing,
  planTests,
  runLabel,
  runTests,
  selectAffectedPackages,
  testCommand,
  workersPerSuite,
} from '../run-tests';

let root: string;

function pkg(dir: string, name: string, deps: Record<string, string> = {}, testScript?: string) {
  mkdirSync(join(root, 'packages', dir), { recursive: true });
  writeFileSync(
    join(root, 'packages', dir, 'package.json'),
    JSON.stringify({
      name,
      dependencies: deps,
      scripts: testScript ? { test: testScript } : undefined,
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'run-tests-'));
  pkg('shared', '@x/shared', {}, 'exit 0');
  pkg('core', '@x/core', { '@x/shared': 'workspace:*' }, 'exit 0');
  pkg('server', '@x/server', { '@x/core': 'workspace:*', hono: '^4' }, 'exit 0');
  pkg('client', '@x/client', { '@x/shared': 'workspace:*' }, 'exit 0');
  // No test script: never selected, but still part of the dependency graph.
  pkg('sdk', '@x/sdk', { '@x/core': 'workspace:*' });
  pkg('cli', '@x/cli', { '@x/sdk': 'workspace:*' }, 'exit 0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('selectAffectedPackages', () => {
  const select = (files: string[]) =>
    selectAffectedPackages(files, discoverPackages(root)).map((p) => p.name);

  test('a package change selects it and every package depending on it, transitively', () => {
    expect(select(['packages/core/src/a.ts'])).toEqual(['@x/cli', '@x/core', '@x/server']);
    expect(select(['packages/shared/src/a.ts'])).toEqual([
      '@x/cli',
      '@x/client',
      '@x/core',
      '@x/server',
      '@x/shared',
    ]);
  });

  test('a leaf change selects only that package', () => {
    expect(select(['packages/client/src/a.tsx'])).toEqual(['@x/client']);
  });

  test('a package without a test script still propagates to its dependents', () => {
    expect(select(['packages/sdk/src/a.ts'])).toEqual(['@x/cli']);
  });

  test('root manifests, configs and the test runner select every package with tests', () => {
    for (const file of ['package.json', 'bun.lock', 'tsconfig.base.json', 'scripts/test-env.ts']) {
      expect(select([file])).toHaveLength(5);
    }
  });

  test('docs, CI config and unrelated files select nothing', () => {
    expect(select(['README.md', '.github/workflows/ci.yml', 'docs/guide.md'])).toEqual([]);
  });
});

describe('selectAffectedPackages with changed dependencies', () => {
  const select = (files: string[], changedDeps: Set<string> | null) =>
    selectAffectedPackages(files, discoverPackages(root), changedDeps).map((p) => p.name);

  test('a lockfile change selects the packages declaring a changed dependency', () => {
    expect(select(['bun.lock', 'package.json'], new Set(['hono']))).toEqual(['@x/server']);
  });

  test('a lockfile change touching no declared dependency selects nothing', () => {
    expect(select(['bun.lock'], new Set(['left-pad']))).toEqual([]);
  });

  test('an unattributable lockfile change selects every package with tests', () => {
    expect(select(['bun.lock'], null)).toHaveLength(5);
  });

  test('other global inputs stay global', () => {
    expect(select(['bunfig.toml'], new Set())).toHaveLength(5);
  });
});

describe('planTests', () => {
  beforeEach(() => {
    pkg('web', '@x/web', { '@x/shared': 'workspace:*', react: '^19' }, 'bun test --parallel');
    pkg('api', '@x/api', { '@x/core': 'workspace:*' }, 'bun test');
  });

  const plan = (files: string[], changedDeps?: Set<string> | null) =>
    Object.fromEntries(
      planTests(files, discoverPackages(root), changedDeps, root).map((run) => [
        run.pkg.name,
        run.testFiles ?? 'whole',
      ]),
    );

  test('without a narrower, a source change runs the affected suites whole', () => {
    expect(plan(['packages/shared/src/a.ts', 'packages/core/src/b.ts'])).toMatchObject({
      '@x/web': 'whole',
      '@x/api': 'whole',
      '@x/shared': 'whole',
    });
  });

  test('a suite input upstream selects the dependents', () => {
    expect(plan(['packages/core/package.json'])['@x/api']).toBe('whole');
  });

  test('a changed dependency runs its users and their dependents whole', () => {
    expect(plan(['bun.lock'], new Set(['react']))).toEqual({ '@x/web': 'whole' });
    expect(plan(['bun.lock'], new Set(['hono']))).toEqual({ '@x/server': 'whole' });
  });

  test('a global input runs every suite whole', () => {
    const runs = plan(['bunfig.toml']);
    expect(Object.values(runs).every((scope) => scope === 'whole')).toBe(true);
    expect(Object.keys(runs)).toHaveLength(7);
  });
});

describe('planTests with a test-impact narrower', () => {
  beforeEach(() => {
    pkg('server', '@x/server', { '@x/core': 'workspace:*' }, 'bun test --isolate');
    pkg('web', '@x/web', { '@x/shared': 'workspace:*' }, 'npm test');
    mkdirSync(join(root, 'packages/shared/src'), { recursive: true });
    writeFileSync(join(root, 'packages/shared/src/a.ts'), '');
  });

  const plan = (files: string[], narrowing: Narrowing, changedDeps?: Set<string>) => {
    const asked: string[] = [];
    const runs = planTests(files, discoverPackages(root), changedDeps, root, (p) => {
      asked.push(p.name);
      return narrowing;
    });
    return { asked, runs: Object.fromEntries(runs.map((run) => [run.pkg.name, run])) };
  };

  test('a bun test suite runs only the test files the map selects', () => {
    const { asked, runs } = plan(['packages/shared/src/a.ts'], { tests: ['./src/a.test.ts'] });
    expect(asked).toEqual(['@x/server']);
    expect(runs['@x/server'].testFiles).toEqual(['./src/a.test.ts']);
    expect(runLabel(runs['@x/server'])).toBe('@x/server (1 test files)');
    // Suites that are not `bun test` are not narrowed by the map.
    expect(asked).not.toContain('@x/web');
    expect(runs['@x/web'].testFiles).toBeUndefined();
    expect(runs['@x/shared'].testFiles).toBeUndefined();
  });

  test('a suite the map selects nothing in is dropped', () => {
    const { runs } = plan(['packages/shared/src/a.ts'], { tests: [] });
    expect(runs['@x/server']).toBeUndefined();
    expect(runs['@x/core']).toBeDefined();
  });

  test('a suite the map cannot narrow runs whole with the reason', () => {
    const { runs } = plan(['packages/shared/src/a.ts'], { whole: 'no test-impact map' });
    expect(runs['@x/server'].testFiles).toBeUndefined();
    expect(runs['@x/server'].note).toBe('no test-impact map');
  });

  test('suite inputs and changed dependencies bypass the narrower', () => {
    for (const file of [
      'packages/server/bunfig.toml',
      'packages/server/package.json',
      'packages/server/src/__tests__/setup.ts',
    ]) {
      const { asked, runs } = plan([file], { tests: [] });
      expect(asked).toEqual([]);
      expect(runs['@x/server'].testFiles).toBeUndefined();
    }
    const deps = plan(['bun.lock'], { tests: [] }, new Set(['hono']));
    expect(deps.asked).toEqual([]);
  });
});

describe('workersPerSuite', () => {
  test('splits the cores between the suites running at once', () => {
    expect(workersPerSuite(4, 20)).toBe(5);
    expect(workersPerSuite(3, 8)).toBe(2);
    expect(workersPerSuite(4, 2)).toBe(1);
  });

  test('leaves a suite running alone to bun', () => {
    expect(workersPerSuite(1, 20)).toBeUndefined();
  });
});

describe('runTests', () => {
  test('passes when every suite passes and fails when any suite fails', async () => {
    pkg('broken', '@x/broken', {}, 'exit 3');
    const all = discoverPackages(root);
    const byName = (name: string) => all.filter((p) => p.name === name);

    expect(await runTests(byName('@x/shared'), root)).toBe(0);
    expect(await runTests([...byName('@x/broken'), ...byName('@x/shared')], root)).toBe(1);
  });

  test('runs up to `concurrency` suites at once', async () => {
    const log = join(root, 'events');
    const script = `echo s >> '${log}'; sleep 0.3; echo e >> '${log}'`;
    for (const name of ['a', 'b', 'c', 'd', 'e']) pkg(`p-${name}`, `@p/${name}`, {}, script);
    const suites = discoverPackages(root).filter((p) => p.name.startsWith('@p/'));

    expect(await runTests(suites, root, 2)).toBe(0);
    let running = 0;
    let peak = 0;
    for (const event of (await Bun.file(log).text()).trim().split('\n')) {
      running += event === 's' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);
  });

  test('caps a bun test --parallel suite to its share of the cores when suites run side by side', async () => {
    // A fake `bun` on PATH records its arguments.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const log = join(root, 'bun-args');
    writeFileSync(join(root, 'node_modules', '.bin', 'bun'), `#!/bin/sh\necho "$@" > '${log}'\n`, {
      mode: 0o755,
    });
    pkg('web', '@x/web', {}, 'bun test --parallel --timeout 20000');
    const suites = discoverPackages(root).filter((p) => ['@x/web', '@x/shared'].includes(p.name));

    expect(await runTests(suites, root, 2)).toBe(0);
    expect(await Bun.file(log).text()).toMatch(/^test --parallel=\d+ --timeout 20000\n$/);
  });

  test('a narrowed bun test run appends the selected files to the test script', async () => {
    pkg('server', '@x/server', {}, 'sh record.sh');
    writeFileSync(join(root, 'packages/server/record.sh'), 'echo "$@" > args\n');
    const server = discoverPackages(root).find((p) => p.name === '@x/server')!;
    const code = await runTests(
      [{ pkg: server, testFiles: ['./src/a.test.ts', "./src/it's.test.ts"] }],
      root,
    );
    expect(code).toBe(0);
    expect(await Bun.file(join(root, 'packages/server/args')).text()).toBe(
      "./src/a.test.ts ./src/it's.test.ts\n",
    );
  });
});

describe('testCommand', () => {
  const suite = (testScript: string) => ({
    name: '@x/a',
    dir: 'packages/a',
    deps: [],
    externalDeps: [],
    hasTest: true,
    testScript,
  });

  test('runs the package script when nothing narrows or caps it', () => {
    expect(testCommand({ pkg: suite('bun test --parallel') })).toEqual(['bun', 'run', 'test']);
    expect(testCommand({ pkg: suite('bun test') }, 4)).toEqual(['bun', 'run', 'test']);
  });

  test('caps --parallel only when it has no worker count yet', () => {
    expect(testCommand({ pkg: suite('bun test --parallel --timeout 1') }, 4)).toEqual([
      'sh',
      '-c',
      'bun test --parallel=4 --timeout 1',
    ]);
    expect(testCommand({ pkg: suite('bun test --parallel=2') }, 4)).toEqual(['bun', 'run', 'test']);
  });

  test('appends narrowed test files, quoted', () => {
    expect(
      testCommand({ pkg: suite('bun test --parallel'), testFiles: ["./it's.test.ts"] }, 3),
    ).toEqual(['sh', '-c', "bun test --parallel=3 './it'\\''s.test.ts'"]);
  });
});
