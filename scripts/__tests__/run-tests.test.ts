import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPackages, runTests, selectAffectedPackages } from '../run-tests';

let root: string;

function pkg(dir: string, name: string, deps: Record<string, string> = {}, testScript?: string) {
  mkdirSync(join(root, 'packages', dir), { recursive: true });
  writeFileSync(
    join(root, 'packages', dir, 'package.json'),
    JSON.stringify({
      name,
      dependencies: deps,
      ...(testScript ? { scripts: { test: testScript } } : {}),
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

describe('runTests', () => {
  test('passes when every suite passes and fails when any suite fails', async () => {
    pkg('broken', '@x/broken', {}, 'exit 3');
    const all = discoverPackages(root);
    const byName = (name: string) => all.filter((p) => p.name === name);

    expect(await runTests(byName('@x/shared'), root)).toBe(0);
    expect(await runTests([...byName('@x/broken'), ...byName('@x/shared')], root)).toBe(1);
  });
});
