import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue #490: the client stores and hooks below exceeded the repository's
 * `max-lines` (800) and `max-lines-per-function` (250) limits. The limits are
 * still warnings, so `bun run lint` passes with them; this test keeps these
 * files under both limits until the rule becomes an error (#447).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const FILES = [
  'packages/client/src/stores/thread-store.ts',
  'packages/client/src/stores/ui-store.ts',
  'packages/client/src/stores/test-store.ts',
  'packages/client/src/stores/browser-panel-store.ts',
  'packages/client/src/hooks/ws-event-dispatch.ts',
  'packages/client/src/hooks/use-review-state.ts',
  'packages/client/src/hooks/use-review-actions.ts',
  'packages/client/src/hooks/use-diff-data.ts',
];

describe('client stores and hooks line limits (#490)', () => {
  test(
    'no max-lines or max-lines-per-function warning',
    () => {
      const run = spawnSync(
        process.execPath,
        ['scripts/bun-lint.ts', '--format', 'agent', ...FILES],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      const output = `${run.stdout}\n${run.stderr}`;
      // The linter must actually have run on the files (not failed to load its config).
      expect(output).not.toContain('Cannot load the configuration file');
      const lineLimitWarnings = output
        .split('\n')
        .filter((line) => /eslint\(max-lines(-per-function)?\)/.test(line));
      expect(lineLimitWarnings).toEqual([]);
    },
    { timeout: 60_000 },
  );
});
