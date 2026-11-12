import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { planCheck, type CheckRequest } from '../../../services/checks/toolchain.js';

const dirs: string[] = [];

/** A project directory with the given files (objects become JSON). */
function project(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'funny-toolchain-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The plan, failing the test when there is none. */
const planned = (dir: string, request: CheckRequest) =>
  planCheck(dir, request).match(
    (plan) => plan,
    (error) => {
      throw new Error(error.message);
    },
  );

const notDetected = (dir: string, request: CheckRequest) =>
  planCheck(dir, request).match(
    () => {
      throw new Error('expected no plan');
    },
    (error) => error,
  );

const commands = (dir: string, request: CheckRequest) =>
  planned(dir, request).steps.map((step) => step.command);

describe('planCheck', () => {
  test('vitest project without a test script runs vitest with the lockfile manager', () => {
    const dir = project({
      'package.json': { devDependencies: { vitest: '4' } },
      'pnpm-lock.yaml': '',
    });
    const plan = planned(dir, { kind: 'test' });
    expect(plan).toMatchObject({ progress: 'test', vitest: true });
    expect(plan.steps).toEqual([
      { name: 'vitest', command: 'pnpm exec vitest run', tool: 'vitest' },
    ]);
  });

  test('a project script wins over the tool', () => {
    const dir = project({
      'package.json': { scripts: { typecheck: 'tsc -b' }, devDependencies: { typescript: '5' } },
      'tsconfig.json': '{}',
      'bun.lock': '',
    });
    expect(commands(dir, { kind: 'typecheck' })).toEqual(['bun run typecheck']);
  });

  test('scope or filter use the tool directly, in its own syntax', () => {
    const dir = project({
      'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } },
      'package-lock.json': '{}',
    });
    expect(
      commands(dir, { kind: 'test', scope: ['src/a.test.ts'], filter: 'parses dates' }),
    ).toEqual(["npx vitest run src/a.test.ts -t 'parses dates'"]);
  });

  test('scope globs reach the shell unquoted; other unsafe text stays quoted', () => {
    const dir = project({ 'package.json': {}, 'bun.lock': '' });
    expect(
      commands(dir, {
        kind: 'test',
        scope: ['src/__tests__/routes/*trpc*.test.ts', 'my dir/a.test.ts'],
        filter: 'adds*',
      }),
    ).toEqual(["bun test src/__tests__/routes/*trpc*.test.ts 'my dir/a.test.ts' -t 'adds*'"]);
  });

  test('a test script that is plain vitest still gets the reporter', () => {
    const dir = project({
      'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } },
    });
    expect(planned(dir, { kind: 'test' })).toMatchObject({
      vitest: true,
      steps: [{ command: 'npm run test' }],
    });
  });

  test('jest, bun and playwright projects', () => {
    expect(
      commands(project({ 'package.json': { devDependencies: { jest: '29' } } }), {
        kind: 'test',
        filter: 'adds',
      }),
    ).toEqual(['npx jest -t adds']);
    expect(
      commands(project({ 'package.json': {}, 'bun.lock': '' }), { kind: 'test', scope: ['src'] }),
    ).toEqual(['bun test src']);
    expect(
      commands(project({ 'package.json': { devDependencies: { '@playwright/test': '1' } } }), {
        kind: 'test',
        filter: 'login',
      }),
    ).toEqual(['npx playwright test --grep login']);
  });

  test('python, rust and go defaults', () => {
    const py = project({ 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n', 'uv.lock': '' });
    expect(commands(py, { kind: 'test', filter: 'slow' })).toEqual(['uv run pytest -k slow']);
    expect(commands(py, { kind: 'lint' })).toEqual(['uv run ruff check .']);
    expect(commands(py, { kind: 'typecheck' })).toEqual(['uv run mypy .']);
    const rust = project({ 'Cargo.toml': '[package]' });
    expect(commands(rust, { kind: 'test' })).toEqual(['cargo test']);
    expect(commands(rust, { kind: 'lint' })).toEqual(['cargo clippy']);
    expect(commands(project({ 'go.mod': 'module x' }), { kind: 'test' })).toEqual([
      'go test ./...',
    ]);
  });

  test('lint and format tools from dependencies', () => {
    const dir = project({
      'package.json': { devDependencies: { oxlint: '1', oxfmt: '1' } },
      'bun.lock': '',
    });
    expect(commands(dir, { kind: 'lint' })).toEqual(['bunx oxlint']);
    expect(commands(dir, { kind: 'format', scope: ['src/a.ts'] })).toEqual([
      'bunx oxfmt --write src/a.ts',
    ]);
  });

  test("funny's own runners write their progress file themselves", () => {
    const dir = project({
      'package.json': {
        scripts: {
          test: 'bun scripts/run-tests.ts',
          steps: 'bun scripts/run-steps.ts',
          lint: 'oxlint .',
        },
      },
      'bun.lock': '',
    });
    expect(planned(dir, { kind: 'test' })).toMatchObject({
      progressEnv: 'FUNNY_TEST_PROGRESS',
      steps: [{ command: 'bun run test' }],
    });
    expect(planned(dir, { kind: 'lint' })).toMatchObject({
      progressEnv: 'FUNNY_TASK_PROGRESS',
      steps: [{ command: 'bun run steps lint' }],
    });
    expect(planned(dir, { kind: 'verify' }).steps).toEqual([
      { name: 'verify', command: 'bun run steps verify', tool: 'script' },
    ]);
  });

  test('verify without a script runs lint, typecheck and test in one task', () => {
    const dir = project({
      'package.json': { devDependencies: { oxlint: '1', typescript: '5', vitest: '4' } },
      'tsconfig.json': '{}',
      'bun.lock': '',
    });
    const plan = planned(dir, { kind: 'verify' });
    expect(plan.progress).toBe('task');
    expect(plan.steps.map((step) => step.tool)).toEqual(['oxlint', 'tsc', 'vitest']);
  });

  test('an exact command is planned as given and classified', () => {
    const dir = project({});
    expect(
      planned(dir, { kind: 'test', command: 'bunx vitest run --project client' }),
    ).toMatchObject({
      kind: 'test',
      vitest: true,
      steps: [{ command: 'bunx vitest run --project client', tool: 'vitest' }],
    });
    expect(planned(dir, { kind: 'build', command: 'make all' })).toMatchObject({
      kind: 'build',
      steps: [{ tool: 'unknown' }],
      notes: [expect.stringContaining('not a recognised check')],
    });
  });

  test('nothing detected says what was looked for', () => {
    const error = notDetected(project({ 'package.json': {} }), { kind: 'lint' });
    expect(error.kind).toBe('not-detected');
    expect(error.message).toContain('found package.json');
    expect(error.message).toContain('"command"');
  });
});
