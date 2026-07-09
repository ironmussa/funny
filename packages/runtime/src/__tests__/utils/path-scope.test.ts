/**
 * Security HI-2 regression tests — `requirePickerPath` / `requireProjectPath`
 * must follow realpath so a symlink in $HOME (or a project tree) can't be
 * used to escape into `/etc`, another user's $HOME, etc.
 *
 * Pattern: create a real symlink in a tmp $HOME, mock `homedir()` to point
 * at that tmp dir, and assert that picker scope refuses to resolve the
 * symlink onto a blocked target.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock $HOME so the picker scope check operates against a sandboxed dir
// where we can plant symlinks at will. Compute the path inline inside the
// hoisted callback — top-level imports (resolve/tmpdir) aren't visible at
// hoist time. `require()` works because the test file is CJS-bridged by
// vitest.
const { FAKE_HOME } = vi.hoisted(() => {
  const pathMod = require('path') as typeof import('path');
  const osMod = require('os') as typeof import('os');
  return { FAKE_HOME: pathMod.resolve(osMod.tmpdir(), 'funny-path-scope-test-' + Date.now()) };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => FAKE_HOME };
});

// Stub the service registry so requireProjectPath() can pretend the test
// owns a project at `${FAKE_HOME}/proj`.
const { mockListProjects } = vi.hoisted(() => ({ mockListProjects: vi.fn() }));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { listProjects: mockListProjects } }),
}));

import { requirePickerPath, requireProjectPath } from '../../utils/path-scope.js';

beforeAll(() => {
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(resolve(FAKE_HOME, 'proj'), { recursive: true });
  writeFileSync(resolve(FAKE_HOME, 'proj', 'README.md'), 'hello');

  // Create symlinks pointing OUTSIDE $HOME — these are the attack vectors.
  symlinkSync('/etc', resolve(FAKE_HOME, 'sneaky-etc'));
  // Symlink inside the project that escapes to /etc.
  symlinkSync('/etc', resolve(FAKE_HOME, 'proj', 'sneaky-etc'));
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  mockListProjects.mockReset();
  mockListProjects.mockResolvedValue([{ path: resolve(FAKE_HOME, 'proj') }]);
});

describe('requirePickerPath — symlink escape (security HI-2)', () => {
  test('rejects a $HOME symlink whose realpath is /etc', async () => {
    const res = await requirePickerPath(resolve(FAKE_HOME, 'sneaky-etc'));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  test('allows a normal directory inside $HOME', async () => {
    const res = await requirePickerPath(resolve(FAKE_HOME, 'proj'));
    expect(res).toBeNull();
  });

  test('rejects literal /etc', async () => {
    const res = await requirePickerPath('/etc');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  test('rejects path containing ..', async () => {
    const res = await requirePickerPath(`${FAKE_HOME}/proj/../../../etc`);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(400);
  });
});

describe('requireProjectPath — symlink escape (security HI-2)', () => {
  test('rejects a symlink inside the project that escapes to /etc', async () => {
    const res = await requireProjectPath(resolve(FAKE_HOME, 'proj', 'sneaky-etc'), 'user-1');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  test('allows a real path inside the project', async () => {
    const res = await requireProjectPath(resolve(FAKE_HOME, 'proj', 'README.md'), 'user-1');
    expect(res).toBeNull();
  });

  test('rejects a path under a different project the user does not own', async () => {
    const res = await requireProjectPath(resolve(FAKE_HOME, 'other-project'), 'user-1');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });
});
