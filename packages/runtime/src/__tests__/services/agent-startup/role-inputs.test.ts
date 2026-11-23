/**
 * A read-only role's inputs (the issue's text): written outside the checkout,
 * readable only by the runner's user, under a folder named by the thread.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  existingRoleInputsDir,
  roleInputsDirFor,
  writeRoleInputs,
} from '../../../services/agent-startup/role-inputs.js';
import { createThreadSchema } from '../../../validation/schemas.js';

describe('role inputs', () => {
  test('are written for the thread, private to the runner user', async () => {
    const threadId = `t-${crypto.randomUUID().slice(0, 8)}`;
    expect(existingRoleInputsDir(threadId)).toBeNull();
    await writeRoleInputs(threadId, { 'issue.md': '# Issue #7' });
    const dir = existingRoleInputsDir(threadId)!;
    expect(dir).toBe(roleInputsDirFor(threadId)!);
    expect(readFileSync(join(dir, 'issue.md'), 'utf8')).toBe('# Issue #7');
    expect(statSync(join(dir, 'issue.md')).mode & 0o077).toBe(0);
    expect(statSync(join(dir, '..')).mode & 0o077).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test('a thread id that could leave the folder gets none', () => {
    expect(roleInputsDirFor('../etc')).toBeNull();
    expect(roleInputsDirFor('a/b')).toBeNull();
  });

  test('a thread that is not read-only cannot be given any', () => {
    const base = { projectId: 'p1', mode: 'worktree', prompt: 'Fix it' };
    const inputs = { 'issue.md': '# Issue' };
    expect(createThreadSchema.safeParse({ ...base, roleInputs: inputs }).success).toBe(false);
    expect(
      createThreadSchema.safeParse({ ...base, readOnly: true, roleInputs: inputs }).success,
    ).toBe(true);
    expect(
      createThreadSchema.safeParse({ ...base, readOnly: true, roleInputs: { '../x': 'y' } })
        .success,
    ).toBe(false);
  });
});
