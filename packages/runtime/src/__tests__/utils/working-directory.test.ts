import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { requireWorkingDirectory } from '../../utils/working-directory.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'funny-directory-'));
  roots.push(root);
  return root;
}

describe('requireWorkingDirectory', () => {
  test('accepts an existing folder', () => {
    const root = fixture();
    expect(requireWorkingDirectory(root)._unsafeUnwrap()).toBe(root);
  });

  test('explains how to recover a deleted project folder', () => {
    const path = join(fixture(), 'project');
    mkdirSync(path);
    rmSync(path, { recursive: true });
    const error = requireWorkingDirectory(path)._unsafeUnwrapErr();
    expect(error.type).toBe('BAD_REQUEST');
    expect(error.message).toContain(path);
    expect(error.message).toContain('moved or deleted');
    expect(error.message).toContain('Restore it');
  });

  test('explains when the location is a file', () => {
    const path = join(fixture(), 'file');
    writeFileSync(path, 'text');
    expect(requireWorkingDirectory(path)._unsafeUnwrapErr().message).toContain('not a folder');
    expect(requireWorkingDirectory(join(path, 'child'))._unsafeUnwrapErr().message).toContain(
      'could not be found',
    );
  });
});
