import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPackages, planTests, runTests, selectAffectedPackages } from '../run-tests';

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
    pkg('web', '@x/web', { '@x/shared': 'workspace:*', react: '^19' }, 'vitest run --project unit');
    pkg('api', '@x/api', { '@x/core': 'workspace:*' }, 'bun --bun vitest run');
    for (const file of ['shared/src/a.ts', 'core/src/b.ts', 'web/src/c.tsx']) {
      mkdirSync(join(root, 'packages', file, '..'), { recursive: true });
      writeFileSync(join(root, 'packages', file), '');
    }
  });

  const plan = (files: string[], changedDeps?: Set<string> | null) =>
    Object.fromEntries(
      planTests(files, discoverPackages(root), changedDeps, root).map((run) => [
        run.pkg.name,
        run.related?.map((path) => path.slice(root.length + 1)) ?? 'whole',
      ]),
    );

  test('a vitest suite selected by source changes runs only the related tests', () => {
    expect(plan(['packages/shared/src/a.ts', 'packages/core/src/b.ts'])).toMatchObject({
      '@x/web': ['packages/shared/src/a.ts', 'packages/core/src/b.ts'],
      '@x/api': ['packages/shared/src/a.ts', 'packages/core/src/b.ts'],
      '@x/shared': 'whole',
    });
  });

  test('deleted files are not passed to vitest related', () => {
    expect(plan(['packages/web/src/gone.tsx', 'packages/web/src/c.tsx'])['@x/web']).toEqual([
      'packages/web/src/c.tsx',
    ]);
  });

  test('a config, manifest or setup change runs the suite whole', () => {
    for (const file of [
      'packages/web/vitest.config.ts',
      'packages/web/package.json',
      'packages/web/src/__tests__/setup.ts',
    ]) {
      expect(plan([file])['@x/web']).toBe('whole');
    }
  });

  test('a suite input upstream runs the dependents whole too', () => {
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

  test('a related run replaces `vitest run` with `vitest related` and passes the files', async () => {
    // A fake `vitest` on PATH records its arguments.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const log = join(root, 'vitest-args');
    writeFileSync(
      join(root, 'node_modules', '.bin', 'vitest'),
      `#!/bin/sh\necho "$@" > '${log}'\n`,
      {
        mode: 0o755,
      },
    );
    pkg('web', '@x/web', {}, 'vitest run --project unit');
    const web = discoverPackages(root).find((p) => p.name === '@x/web')!;

    const code = await runTests([{ pkg: web, related: ["/repo/it's here.ts"] }], root);
    expect(code).toBe(0);
    expect(await Bun.file(log).text()).toBe(
      "related --run --passWithNoTests --project unit /repo/it's here.ts\n",
    );
  });
});
