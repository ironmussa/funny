/**
 * File-scoped module mocks for `bun test`.
 *
 * `mock.module()` is process-global: when the whole suite runs in one process
 * (`bun test` without `--isolate`), a module mocked by one file stays mocked for
 * every file that runs after it — and `mock.restore()` does NOT undo it. Partial
 * mocks (factories that omit exports) then break unrelated suites with
 * "Export named 'x' not found", and stubs silently change behavior elsewhere.
 *
 * These helpers keep a mock scoped to the file that installs it: the mock
 * spreads the REAL module (so no export goes missing) and an `afterAll` hook
 * re-installs the real exports once the file finishes.
 */
import { afterAll, mock } from 'bun:test';

import * as coreGitNs from '@funny/core/git';

type ModuleExports = Record<string, unknown>;

/**
 * Snapshot a module namespace. Bun updates already-imported namespaces in place
 * when a module is mocked, so take the copy BEFORE calling `mock.module`.
 */
export function snapshotModule(ns: object): ModuleExports {
  return { ...(ns as ModuleExports) };
}

/**
 * Install `mock.module(specifier, factory)` for the current test file and
 * re-install `real` in `afterAll`. `specifier` must be a bare package name or an
 * absolute path, because `mock.module` resolves relative specifiers against the
 * file that calls it (this helper, not the test file).
 */
function mockModuleForFile(specifier: string, real: ModuleExports, overrides: ModuleExports): void {
  mock.module(specifier, () => ({ ...real, ...overrides }));
  afterAll(() => {
    mock.module(specifier, () => real);
  });
}

// Captured when this helper is first loaded — before any file mocks the barrel,
// because every `@funny/core/git` mock in this package goes through here and is
// restored when its file finishes.
const realCoreGit = snapshotModule(coreGitNs);

/**
 * Stub the git-repo filesystem checks of `@funny/core/git` for the current
 * test file (suites seed projects straight into the DB, not real repos). All
 * other exports — including the HI-3 path validators — stay real.
 */
export function mockCoreGitRepoChecks(): void {
  mockModuleForFile('@funny/core/git', realCoreGit, {
    isGitRepoSync: () => true,
    isGitRepoRootSync: () => true,
    ensureWeaveConfigured: () => Promise.resolve(),
  });
}
