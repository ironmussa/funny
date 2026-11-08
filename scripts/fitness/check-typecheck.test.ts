import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTypecheck, selectAffectedProjects } from './check-typecheck';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'funny-typecheck-'));
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['index.ts'] }),
  );
  writeFileSync(join(cwd, 'index.ts'), 'const value: number = 1;');
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

test('accepts a clean project without emitting files', () => {
  expect(runTypecheck('tsconfig.json', cwd)).toEqual([]);
  expect(existsSync(join(cwd, 'index.js'))).toBe(false);
});

test('accepts bun check diagnostic exit status and normalizes diagnostics independently of line numbers and agent output mode', () => {
  const previous = process.env.AGENT;
  process.env.AGENT = '1';
  try {
    writeFileSync(join(cwd, 'index.ts'), 'const value: number = "wrong";');
    const errors = runTypecheck('tsconfig.json', cwd);
    expect(errors).toEqual([
      {
        file: 'index.ts',
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    writeFileSync(join(cwd, 'index.ts'), '\n\nconst value: number = "wrong";');
    expect(runTypecheck('tsconfig.json', cwd)).toEqual(errors);
  } finally {
    if (previous === undefined) delete process.env.AGENT;
    else process.env.AGENT = previous;
  }
});

test('rejects missing projects instead of reporting a clean check', () => {
  expect(() => runTypecheck('missing.json', cwd)).toThrow('bun check');
});

test('rejects invalid compiler options', () => {
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"target":"invalid"}}');
  expect(() => runTypecheck('tsconfig.json', cwd)).toThrow('bun check');
});

test('rejects empty projects', () => {
  writeFileSync(join(cwd, 'tsconfig.json'), '{"files":[]}');
  expect(() => runTypecheck('tsconfig.json', cwd)).toThrow('bun check');
});

test('rejects syntax failures that stop type checking early', () => {
  writeFileSync(join(cwd, 'index.ts'), 'const value: = ;');
  expect(() => runTypecheck('tsconfig.json', cwd)).toThrow('bun check');
});

describe('selectAffectedProjects', () => {
  let root: string;
  const PROJECTS = [
    'packages/shared/tsconfig.json',
    'packages/core/tsconfig.json',
    'packages/server/tsconfig.json',
    'packages/client/tsconfig.json',
    'packages/bench/tsconfig.json',
    'scripts/tool/tsconfig.json',
  ];

  function pkg(dir: string, name: string, deps: Record<string, string> = {}, tsconfig = '{}') {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(
      join(root, 'packages', dir, 'package.json'),
      JSON.stringify({ name, dependencies: deps }),
    );
    writeFileSync(join(root, 'packages', dir, 'tsconfig.json'), tsconfig);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'affected-projects-'));
    pkg('shared', '@x/shared');
    pkg('core', '@x/core', { '@x/shared': 'workspace:*' });
    pkg('server', '@x/server', { '@x/core': 'workspace:*', hono: '^4' });
    pkg('client', '@x/client', { '@x/shared': 'workspace:*' });
    // Reaches into core's sources through tsconfig, without a dependency.
    pkg('bench', '@x/bench', {}, '{ "include": ["./src", "../core/src"] }');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const select = (files: string[]) => selectAffectedProjects(files, PROJECTS, root);

  test('a package change selects it and every project depending on it, transitively', () => {
    expect(select(['packages/shared/src/a.ts'])).toEqual([
      'packages/shared/tsconfig.json',
      'packages/core/tsconfig.json',
      'packages/server/tsconfig.json',
      'packages/client/tsconfig.json',
      'packages/bench/tsconfig.json',
      'scripts/tool/tsconfig.json',
    ]);
  });

  test('a leaf change selects only that project (and projects outside packages/)', () => {
    expect(select(['packages/client/src/App.tsx'])).toEqual([
      'packages/client/tsconfig.json',
      'scripts/tool/tsconfig.json',
    ]);
  });

  test('tsconfig includes into another package count as a dependency', () => {
    expect(select(['packages/core/src/git.ts'])).toEqual([
      'packages/core/tsconfig.json',
      'packages/server/tsconfig.json',
      'packages/bench/tsconfig.json',
      'scripts/tool/tsconfig.json',
    ]);
  });

  test('config, manifests, declarations and files outside packages/ select everything', () => {
    for (const file of [
      'packages/client/package.json',
      'packages/client/tsconfig.json',
      'tsconfig.base.json',
      'bun.lock',
      'packages/client/src/env.d.ts',
      'scripts/build.ts',
    ]) {
      expect(select([file])).toEqual(PROJECTS);
    }
  });
});
