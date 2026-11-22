/**
 * The regression proof against real git repositories (a bare `origin`, a fix
 * branch): what counts as a proof, and what is inconclusive. The tests are
 * `sh` scripts, so no test runner or dependency install is involved.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSync } from '@funny/core/git';

import {
  fillCommand,
  inconclusiveBaseFailure,
  matchesGlob,
  runProof,
  type ProofRequest,
} from '../../services/regression-proof.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return executeSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
  }).stdout.trim();
}

/**
 * A repository whose `main` has the bug (`lib.sh` prints 1, it should print
 * 2), pushed to a bare origin, and a `fix` branch with the fix plus `files`.
 * Returns the checkout and the fix commit.
 */
function repoWithFix(files: Record<string, string>): { path: string; headSha: string } {
  const origin = tempDir('funny-proof-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const path = tempDir('funny-proof-repo-');
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'lib.sh'), 'echo 1\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'bug');
  git(path, 'remote', 'add', 'origin', origin);
  git(path, 'push', '-q', 'origin', 'main');
  git(path, 'checkout', '-q', '-b', 'fix');
  writeFileSync(join(path, 'lib.sh'), 'echo 2\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'fix');
  return { path, headSha: git(path, 'rev-parse', 'HEAD') };
}

const ASSERTS_FIX = '[ "$(sh lib.sh)" = 2 ] || { echo "assertion failed: expected 2"; exit 1; }\n';

function prove(
  repo: { path: string; headSha: string },
  over: Partial<ProofRequest> = {},
): ReturnType<typeof runProof> {
  return runProof(
    repo.path,
    {
      headSha: repo.headSha,
      defaultBranch: 'main',
      rules: [{ globs: ['**/*.test.sh'], command: 'sh {{files}}' }],
      supportGlobs: [],
      timeoutMs: 30_000,
      ...over,
    },
    new AbortController().signal,
  );
}

describe('regression proof run', () => {
  test('a test at the repository root that fails on the base and passes on the head proves the fix', async () => {
    const result = await prove(repoWithFix({ 'lib.test.sh': ASSERTS_FIX }));
    expect(result.verdict).toBe('pass');
    expect(result.files).toEqual(['lib.test.sh']);
    expect(result.commands).toEqual(["sh 'lib.test.sh'"]);
    // The evidence kept is the base's assertion failure.
    expect(result.outputTail).toContain('assertion failed: expected 2');
  });

  test('a test that also passes on the base does not catch the bug', async () => {
    const result = await prove(repoWithFix({ 'lib.test.sh': '[ -f lib.sh ]\n' }));
    expect(result.verdict).toBe('fail');
    expect(result.finding).toContain('pass on the base commit');
    expect(result.failureKind).toBe('test');
  });

  test('a base run that only times out is inconclusive, not a proof', async () => {
    const slowOnBase = '[ "$(sh lib.sh)" = 2 ] && exit 0\nsleep 30\n';
    const result = await prove(repoWithFix({ 'lib.test.sh': slowOnBase }), { timeoutMs: 4_000 });
    expect(result.verdict).toBe('fail');
    expect(result.finding).toContain('Inconclusive');
    expect(result.finding).toContain('timed out');
  });

  test('a test file that cannot load on the base is inconclusive, not a proof', async () => {
    const result = await prove(
      repoWithFix({
        'helper.sh': 'true\n',
        'lib.test.sh': '[ -f helper.sh ] || { echo "Cannot find module ./helper.sh"; exit 1; }\n',
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.finding).toContain('could not load');
  });

  test('a test that passes on the head once and then fails is flaky', async () => {
    const counter = join(tempDir('funny-proof-counter-'), 'runs');
    const flaky = `n=$(cat '${counter}' 2>/dev/null || echo 0)\necho $((n + 1)) > '${counter}'\n[ "$n" = 0 ]\n`;
    const result = await prove(repoWithFix({ 'lib.test.sh': flaky }));
    expect(result.verdict).toBe('fail');
    expect(result.finding).toContain('flaky');
    expect(result.failureKind).toBe('test');
  });

  test('the setup command prepares both checkouts before their tests', async () => {
    const needsSetup = `[ -f .prepared ] || { echo "not prepared"; exit 1; }\n${ASSERTS_FIX}`;
    const repo = repoWithFix({ 'lib.test.sh': needsSetup });
    expect((await prove(repo)).finding).toContain('Tests fail on the head commit');
    expect((await prove(repo, { setupCommand: 'touch .prepared' })).verdict).toBe('pass');
  });

  test("without a setup command, the head's .funny.json postCreate prepares both checkouts", async () => {
    const needsSetup = `[ -f .prepared ] || { echo "not prepared"; exit 1; }\n${ASSERTS_FIX}`;
    const repo = repoWithFix({
      'lib.test.sh': needsSetup,
      '.funny.json': JSON.stringify({ postCreate: ['touch .prepared'] }),
    });
    expect((await prove(repo)).verdict).toBe('pass');
  });

  test('a setup command that fails is reported, not run as a test', async () => {
    const result = await prove(repoWithFix({ 'lib.test.sh': ASSERTS_FIX }), {
      setupCommand: 'exit 3',
    });
    expect(result.verdict).toBe('fail');
    expect(result.finding).toContain('Setup failed on the head');
    expect(result.failureKind).toBe('environment');
  });

  test('a head pushed from elsewhere is fetched by its SHA before it is proved', async () => {
    const fixed = repoWithFix({ 'lib.test.sh': ASSERTS_FIX });
    const origin = git(fixed.path, 'remote', 'get-url', 'origin');
    git(fixed.path, 'push', '-q', 'origin', 'fix');
    // GitHub serves any reachable commit by its SHA; a bare repository must be told to.
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    // A checkout that has only main: the fix commit is not here.
    const other = tempDir('funny-proof-other-');
    git(other, 'clone', '-q', '--single-branch', '-b', 'main', origin, '.');
    expect(git(other, 'log', '--all', '--format=%H')).not.toContain(fixed.headSha);

    const result = await prove({ path: other, headSha: fixed.headSha });
    expect(result.verdict).toBe('pass');
  });

  test('no changed test file is skipped', async () => {
    const result = await prove(repoWithFix({ 'notes.md': 'x\n' }));
    expect(result.verdict).toBe('skipped');
  });
});

describe('regression proof helpers', () => {
  test('`**/` also matches no directory, `*` stays inside one', () => {
    expect(matchesGlob('foo.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('a/b/foo.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('a/foo.test.ts', '*.test.ts')).toBe(false);
    expect(matchesGlob('src/__fixtures__/x.json', '**/__fixtures__/**')).toBe(true);
    expect(matchesGlob('foo.test.tsx', '**/*.test.ts')).toBe(false);
  });

  test('`{{files}}` is replaced literally, every time, with each file quoted', () => {
    expect(fillCommand('bun test {{files}}', ["a$'b.test.ts", 'c$&.test.ts'])).toBe(
      "bun test 'a$'\\''b.test.ts' 'c$&.test.ts'",
    );
    expect(fillCommand('x {{files}} && y {{files}}', ['t.ts'])).toBe("x 't.ts' && y 't.ts'");
    expect(fillCommand('bun test {{files}}', ['pkg/a.test.ts'], 'pkg')).toBe(
      "bun test 'a.test.ts'",
    );
  });

  test('only an assertion failure on the base counts', () => {
    expect(
      inconclusiveBaseFailure({ kind: 'exited', exitCode: 1, output: 'expected 2' }),
    ).toBeNull();
    expect(inconclusiveBaseFailure({ kind: 'timed-out', output: '' })).toContain('timed out');
    expect(
      inconclusiveBaseFailure({
        kind: 'exited',
        exitCode: 1,
        output: 'SyntaxError: Unexpected token',
      }),
    ).toContain('could not load');
  });
});
