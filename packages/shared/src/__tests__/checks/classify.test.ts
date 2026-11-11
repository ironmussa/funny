import { describe, expect, test } from 'bun:test';

import { classifyCheckCommand, scriptKind } from '../../checks/classify';

const pick = (command: string) => {
  const check = classifyCheckCommand(command);
  return check && { kind: check.kind, tool: check.tool, plain: check.plain };
};

describe('classifyCheckCommand', () => {
  test.each([
    ['npx vitest run', 'test', 'vitest'],
    ['bunx vitest run src/a.test.ts', 'test', 'vitest'],
    ['pnpm exec vitest', 'test', 'vitest'],
    ['pnpm vitest run', 'test', 'vitest'],
    ['./node_modules/.bin/vitest run', 'test', 'vitest'],
    ['bun test packages/runtime', 'test', 'bun-test'],
    ['npx jest src', 'test', 'jest'],
    ['npx playwright test --project=chromium', 'test', 'playwright'],
    ['uv run pytest tests/test_a.py', 'test', 'pytest'],
    ['python -m pytest -k slow', 'test', 'pytest'],
    ['cargo test -p native-git', 'test', 'cargo'],
    ['go test ./...', 'test', 'go'],
    ['bunx tsc --noEmit', 'typecheck', 'tsc'],
    ['npx tsc -p packages/client', 'typecheck', 'tsc'],
    ['uv run mypy src', 'typecheck', 'mypy'],
    ['cargo check', 'typecheck', 'cargo'],
    ['npx oxlint .', 'lint', 'oxlint'],
    ['npx eslint . --max-warnings=0', 'lint', 'eslint'],
    ['uvx ruff check src', 'lint', 'ruff'],
    ['ruff format --check .', 'format', 'ruff'],
    ['cargo clippy', 'lint', 'cargo'],
    ['bunx oxfmt --check src', 'format', 'oxfmt'],
    ['npx prettier --check .', 'format', 'prettier'],
    ['bun run lint', 'lint', 'script'],
    ['bun run typecheck', 'typecheck', 'script'],
    ['npm test', 'test', 'script'],
    ['npm run test:unit', 'test', 'script'],
    ['pnpm lint', 'lint', 'script'],
    ['yarn build', 'build', 'script'],
    ['bun run --cwd packages/client test', 'test', 'script'],
    ['bun run steps verify', 'verify', 'script'],
  ])('%s → %s / %s', (command, kind, tool) => {
    expect(pick(command)).toEqual({ kind, tool, plain: true } as never);
  });

  test('a leading cd, env assignments and 2>&1 keep a command plain', () => {
    expect(
      classifyCheckCommand('cd packages/client && CI=1 npx vitest run src/a.test.ts 2>&1'),
    ).toEqual({
      kind: 'test',
      tool: 'vitest',
      plain: true,
      cwd: 'packages/client',
      scope: ['src/a.test.ts'],
    });
  });

  test('scope and test-name filters per tool', () => {
    expect(classifyCheckCommand('npx vitest run src/a.test.ts -t "parses dates"')).toMatchObject({
      scope: ['src/a.test.ts'],
      filter: 'parses dates',
    });
    expect(classifyCheckCommand('pytest tests/test_a.py -k slow')).toMatchObject({
      scope: ['tests/test_a.py'],
      filter: 'slow',
    });
    expect(classifyCheckCommand('npx playwright test e2e/a.spec.ts --grep=login')).toMatchObject({
      scope: ['e2e/a.spec.ts'],
      filter: 'login',
    });
    expect(classifyCheckCommand('go test ./internal/... -run TestJoin')).toMatchObject({
      scope: ['./internal/...'],
      filter: 'TestJoin',
    });
  });

  test('pipelines, chains and redirections are checks but not plain', () => {
    expect(pick('bunx tsc --noEmit 2>&1 | rg "error TS" | head')).toEqual({
      kind: 'typecheck',
      tool: 'tsc',
      plain: false,
    });
    expect(pick('bun run lint && bun run typecheck')).toEqual({
      kind: 'lint',
      tool: 'script',
      plain: false,
    });
    expect(pick('npx vitest run > /tmp/out.log')).toEqual({
      kind: 'test',
      tool: 'vitest',
      plain: false,
    });
    expect(pick('cd x && npx vitest run 2>&1 | tail -40')).toEqual({
      kind: 'test',
      tool: 'vitest',
      plain: false,
    });
  });

  test.each([
    'git status',
    'rg "vitest" packages',
    'cat vitest.config.ts',
    'npx vitest watch',
    'bunx tsc --watch',
    'bun run dev',
    'npm install',
    'pnpm add -D vitest',
    'npx prettier src/a.ts',
    'ruff --version',
    'echo "bun run lint"',
  ])('%s is not a check', (command) => {
    expect(classifyCheckCommand(command)).toBeNull();
  });
});

describe('scriptKind', () => {
  test.each([
    ['test', 'test'],
    ['test:e2e', 'test'],
    ['e2e', 'test'],
    ['typecheck', 'typecheck'],
    ['check-types', 'typecheck'],
    ['lint', 'lint'],
    ['lint:fix', 'lint'],
    ['format', 'format'],
    ['build', 'build'],
    ['build:client', 'build'],
    ['dev', null],
    ['start', null],
    ['db:push', null],
  ])('%s → %s', (name, kind) => {
    expect(scriptKind(name)).toBe(kind as never);
  });
});
