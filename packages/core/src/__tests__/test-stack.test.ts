import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { detectTestStack } from '../test-stack.js';

const tempDirs: string[] = [];

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'funny-test-stack-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectTestStack', () => {
  test('detects Nx + pnpm + Jest monorepo with integration specs flagged', () => {
    const dir = createFixture({
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'nx.json': JSON.stringify({ npmScope: 'acme' }),
      'package.json': JSON.stringify({
        name: 'acme-monorepo',
        devDependencies: { jest: '^29.0.0', nx: '^19.0.0' },
      }),
      'apps/api/project.json': JSON.stringify({
        name: 'api',
        targets: {
          test: { executor: '@nx/jest:jest', options: { jestConfig: 'apps/api/jest.config.ts' } },
        },
      }),
      'apps/api/jest.config.ts': 'export default { displayName: "api" };\n',
      'apps/api/src/orders.spec.ts': 'describe("orders", () => { it("works", () => {}); });\n',
      'apps/api/src/orders.integration.spec.ts':
        'import { Client } from "pg";\ndescribe("orders db", () => {});\n',
      'libs/shared/project.json': JSON.stringify({
        name: 'shared',
        targets: {
          test: { executor: '@nx/jest:jest' },
        },
      }),
      'libs/shared/jest.config.ts': 'export default { displayName: "shared" };\n',
      'libs/shared/src/math.spec.ts': 'test("add", () => expect(1 + 1).toBe(2));\n',
      'libs/docs/project.json': JSON.stringify({
        name: 'docs',
        targets: { build: { executor: '@nx/vite:build' } },
      }),
    });

    const result = detectTestStack(dir);
    expect(result.isOk()).toBe(true);
    const facts = result._unsafeUnwrap();

    expect(facts.packageManager).toBe('pnpm');
    expect(facts.monorepo).toBe('nx');
    expect(facts.recognized).toBe(true);
    expect(facts.packages.map((p) => p.name)).toEqual(['api', 'shared']);
    expect(facts.packages[0]).toMatchObject({
      name: 'api',
      root: 'apps/api',
      runner: 'jest',
      configFile: 'apps/api/jest.config.ts',
      nxTestTarget: true,
      sampleTests: ['apps/api/src/orders.spec.ts'],
    });
    expect(facts.packages[1]).toMatchObject({
      name: 'shared',
      root: 'libs/shared',
      runner: 'jest',
      configFile: 'libs/shared/jest.config.ts',
      nxTestTarget: true,
      sampleTests: ['libs/shared/src/math.spec.ts'],
    });
    expect(facts.testPatterns).toContain('**/*.spec.ts');
    expect(facts.infrastructureTests).toEqual([
      expect.objectContaining({ path: 'apps/api/src/orders.integration.spec.ts' }),
    ]);
  });

  test('detects bun workspaces + bun test', () => {
    const dir = createFixture({
      'bun.lock': '{}\n',
      'package.json': JSON.stringify({
        name: 'funny-like',
        workspaces: ['packages/*'],
        scripts: { test: 'bun test' },
      }),
      'packages/core/package.json': JSON.stringify({
        name: '@app/core',
        scripts: { test: 'bun test' },
      }),
      'packages/core/src/util.test.ts':
        'import { test, expect } from "bun:test";\ntest("ok", () => expect(true).toBe(true));\n',
      'packages/server/package.json': JSON.stringify({
        name: '@app/server',
        scripts: { test: 'bun test' },
      }),
      'packages/server/src/health.test.ts': 'test("health", () => {});\n',
      'packages/server/src/db.test.ts':
        'import { GenericContainer } from "testcontainers";\ntest("db", () => {});\n',
    });

    const result = detectTestStack(dir);
    expect(result.isOk()).toBe(true);
    const facts = result._unsafeUnwrap();

    expect(facts.packageManager).toBe('bun');
    expect(facts.monorepo).toBe('bun-workspaces');
    expect(facts.recognized).toBe(true);
    expect(facts.packages.map((p) => ({ name: p.name, runner: p.runner }))).toEqual([
      { name: '@app/core', runner: 'bun' },
      { name: '@app/server', runner: 'bun' },
    ]);
    expect(facts.testPatterns).toContain('**/*.test.ts');
    expect(facts.infrastructureTests).toEqual([
      { path: 'packages/server/src/db.test.ts', reason: 'uses testcontainers' },
    ]);
  });

  test('detects single-package Vitest repository', () => {
    const dir = createFixture({
      'package-lock.json': '{}',
      'package.json': JSON.stringify({
        name: 'web-app',
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^3.0.0' },
      }),
      'vitest.config.ts': 'export default {};\n',
      'src/App.test.tsx': 'import { test } from "vitest";\ntest("renders", () => {});\n',
    });

    const result = detectTestStack(dir);
    expect(result.isOk()).toBe(true);
    const facts = result._unsafeUnwrap();

    expect(facts.packageManager).toBe('npm');
    expect(facts.monorepo).toBeNull();
    expect(facts.recognized).toBe(true);
    expect(facts.packages).toHaveLength(1);
    expect(facts.packages[0]).toMatchObject({
      name: 'web-app',
      root: '.',
      runner: 'vitest',
      configFile: 'vitest.config.ts',
      sampleTests: ['src/App.test.tsx'],
    });
    expect(facts.testPatterns).toContain('**/*.test.tsx');
  });

  test('reports no runner recognized for a Python repository', () => {
    const dir = createFixture({
      'pyproject.toml': '[project]\nname = "py-svc"\n',
      'tests/test_app.py': 'def test_ok():\n    assert True\n',
    });

    const result = detectTestStack(dir);
    expect(result.isOk()).toBe(true);
    const facts = result._unsafeUnwrap();

    expect(facts.recognized).toBe(false);
    expect(facts.packageManager).toBeNull();
    expect(facts.packages).toEqual([]);
    expect(facts.summary.toLowerCase()).toContain('no test runner');
  });

  test('returns a bad request error when checkout directory does not exist', () => {
    const result = detectTestStack(join(tmpdir(), 'nonexistent-funny-test-stack-dir-xyz'));
    expect(result.isErr()).toBe(true);
  });
});
