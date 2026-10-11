import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTypecheck } from './check-typecheck';

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

test('normalizes diagnostics independently of line numbers and agent output mode', () => {
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
