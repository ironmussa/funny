import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
/**
 * Factory steps on the runner (openspec factory-integration 2.1, 2.1b, 3.1,
 * 3.2): a flow's command in the run's checkout with bounded, masked output,
 * and `integrate` merging the base in on temporary repositories.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getFactoryStep,
  matchesGlob,
  OUTPUT_LIMIT,
  recordedOutput,
  secretValues,
  startFactoryStep,
  type FactoryStepResult,
} from '../../services/factory-steps.js';

let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

function write(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
}

function commit(cwd: string, message: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

/** A bare origin with `main`, a clone working on `feature`, and a second clone that pushes to `main`. */
function repos() {
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'a.txt', 'one\ntwo\nthree\n');
  write(seed, 'lock.json', '{"v":1}\n');
  commit(seed, 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.name', 'T');
  git(work, 'config', 'user.email', 't@t');
  git(work, 'checkout', '-q', '-b', 'feature');
  return { origin, seed, work };
}

async function finished(threadId: string, stepId: string): Promise<FactoryStepResult> {
  for (let i = 0; i < 200; i++) {
    const job = getFactoryStep(threadId, stepId);
    if (job?.state === 'done' && job.result) return job.result;
    await Bun.sleep(25);
  }
  throw new Error('the step did not finish');
}

async function run(cwd: string, request: Parameters<typeof startFactoryStep>[2]) {
  const threadId = `t-${Math.random()}`;
  const job = startFactoryStep(threadId, cwd, request);
  return finished(threadId, job.id);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-steps-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('run_command', () => {
  test('runs in the checkout and records the exit and output', async () => {
    const result = await run(root, {
      kind: 'command',
      command: 'pwd && echo out && echo err >&2',
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ kind: 'command', outcome: 'passed', exitCode: 0 });
    if (result.kind !== 'command') return;
    expect(result.stdout).toContain(root);
    expect(result.stderr).toContain('err');
  });

  test('a non-zero exit fails the step', async () => {
    const result = await run(root, { kind: 'command', command: 'exit 3', timeoutMs: 10_000 });
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 3 });
  });

  test('a command past its timeout is killed', async () => {
    const result = await run(root, { kind: 'command', command: 'sleep 5', timeoutMs: 200 });
    expect(result).toMatchObject({ outcome: 'timed-out', exitCode: null });
  });

  test('the values of secrets in its environment are masked when it prints them', async () => {
    const previous = process.env.FUNNY_TEST_API_TOKEN;
    process.env.FUNNY_TEST_API_TOKEN = 'ghs_supersecretvalue123';
    try {
      const result = await run(root, { kind: 'command', command: 'env', timeoutMs: 10_000 });
      if (result.kind !== 'command') throw new Error('expected a command result');
      expect(result.stdout).not.toContain('ghs_supersecretvalue123');
      expect(result.stdout).toContain('FUNNY_TEST_API_TOKEN=[masked]');
    } finally {
      if (previous === undefined) delete process.env.FUNNY_TEST_API_TOKEN;
      else process.env.FUNNY_TEST_API_TOKEN = previous;
    }
  });
});

describe('recorded output', () => {
  test('keeps the last 64 KiB of a stream', () => {
    const text = `${'a'.repeat(OUTPUT_LIMIT)}tail`;
    const recorded = recordedOutput(text, []);
    expect(recorded.length).toBe(OUTPUT_LIMIT);
    expect(recorded.endsWith('tail')).toBe(true);
  });

  test('takes secret values from secret-looking names only, longest first', () => {
    expect(
      secretValues({
        GH_TOKEN: 'abcdefgh1234',
        HOME: '/home/someone/long',
        API_KEY: 'abcdefgh',
        X: 'short',
      }),
    ).toEqual(['abcdefgh1234', 'abcdefgh']);
  });

  test('globs match like the flow file says', () => {
    expect(matchesGlob('bun.lock', 'bun.lock')).toBe(true);
    expect(matchesGlob('packages/a/bun.lock', '**/bun.lock')).toBe(true);
    expect(matchesGlob('migrations/0012_x.sql', 'migrations/*.sql')).toBe(true);
    expect(matchesGlob('migrations/sub/0012_x.sql', 'migrations/*.sql')).toBe(false);
  });
});

describe('integrate', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    kind: 'integrate' as const,
    baseBranch: 'main',
    branch: 'feature',
    regenerators: [],
    checks: [],
    timeoutMs: 20_000,
    ...over,
  });

  test('a branch that already contains the base is left as it is', async () => {
    const { work } = repos();
    const head = git(work, 'rev-parse', 'HEAD');
    const result = await run(work, request());
    expect(result).toMatchObject({ kind: 'integrate', outcome: 'up-to-date', headAfter: head });
  });

  test('a base that merges cleanly is merged in, never rebased, and pushed', async () => {
    const { seed, work, origin } = repos();
    write(work, 'b.txt', 'mine\n');
    commit(work, 'feature work');
    const mine = git(work, 'rev-parse', 'HEAD');
    write(seed, 'c.txt', 'theirs\n');
    commit(seed, 'base moved');
    git(seed, 'push', '-q', 'origin', 'main');

    const result = await run(work, request());
    if (result.kind !== 'integrate') throw new Error('expected an integrate result');
    expect(result.outcome).toBe('merged');
    // A merge commit whose first parent is the branch's own commit.
    expect(git(work, 'rev-parse', 'HEAD^1')).toBe(mine);
    expect(git(origin, 'rev-parse', 'feature')).toBe(result.headAfter);
    // Nothing written to the repository's config.
    expect(readFileSync(join(work, '.git', 'config'), 'utf8')).not.toContain('rerere');
  });

  test('a conflicted lockfile is regenerated, not left to an agent', async () => {
    const { seed, work, origin } = repos();
    write(work, 'lock.json', '{"v":"feature"}\n');
    commit(work, 'feature lock');
    write(seed, 'lock.json', '{"v":"base"}\n');
    commit(seed, 'base lock');
    git(seed, 'push', '-q', 'origin', 'main');

    const result = await run(
      work,
      request({
        regenerators: [
          {
            paths: ['lock.json'],
            run: 'echo \'{"v":"regenerated"}\' > lock.json',
            timeoutMs: 10_000,
          },
        ],
      }),
    );
    if (result.kind !== 'integrate') throw new Error('expected an integrate result');
    expect(result.outcome).toBe('merged');
    expect(result.regeneratedPaths).toEqual(['lock.json']);
    expect(readFileSync(join(work, 'lock.json'), 'utf8')).toBe('{"v":"regenerated"}\n');
    expect(git(origin, 'rev-parse', 'feature')).toBe(result.headAfter);
  });

  // Found in the E2E: the repository's broken husky hook failed the merge commit.
  test("a regenerated merge is committed without the repository's pre-commit hook, as git merge does", async () => {
    const { seed, work, origin } = repos();
    write(work, 'lock.json', '{"v":"feature"}\n');
    commit(work, 'feature lock');
    write(seed, 'lock.json', '{"v":"base"}\n');
    commit(seed, 'base lock');
    git(seed, 'push', '-q', 'origin', 'main');
    // Its own hooks directory, so a hooks path set on the machine cannot hide the hook.
    mkdirSync(join(work, '.test-hooks'));
    write(work, '.test-hooks/pre-commit', '#!/bin/sh\necho broken hook >&2\nexit 1\n');
    chmodSync(join(work, '.test-hooks/pre-commit'), 0o755);
    git(work, 'config', 'core.hooksPath', '.test-hooks');

    const result = await run(
      work,
      request({
        regenerators: [
          {
            paths: ['lock.json'],
            run: 'echo \'{"v":"regenerated"}\' > lock.json',
            timeoutMs: 10_000,
          },
        ],
      }),
    );
    if (result.kind !== 'integrate') throw new Error('expected an integrate result');
    expect(result.outcome).toBe('merged');
    expect(git(origin, 'rev-parse', 'feature')).toBe(result.headAfter);
  });

  // Found on issue #434: `git merge` runs commit-msg, which refused "Merge origin/main into …".
  test("a clean merge runs none of the repository's hooks", async () => {
    const { seed, work, origin } = repos();
    write(work, 'feature.txt', 'feature\n');
    commit(work, 'feature');
    write(seed, 'base.txt', 'base\n');
    commit(seed, 'base');
    git(seed, 'push', '-q', 'origin', 'main');
    const ran = join(work, '.git', 'hooks-ran');
    mkdirSync(join(work, '.test-hooks'));
    for (const hook of ['pre-merge-commit', 'commit-msg', 'pre-commit']) {
      write(work, `.test-hooks/${hook}`, `#!/bin/sh\necho ${hook} >> "${ran}"\nexit 1\n`);
      chmodSync(join(work, `.test-hooks/${hook}`), 0o755);
    }
    git(work, 'config', 'core.hooksPath', '.test-hooks');

    const result = await run(work, request());
    if (result.kind !== 'integrate') throw new Error('expected an integrate result');
    expect(result.outcome).toBe('merged');
    expect(git(origin, 'rev-parse', 'feature')).toBe(result.headAfter);
    expect(existsSync(ran) ? readFileSync(ran, 'utf8') : '').toBe('');
  });

  test('a real conflict is aborted with its paths, and nothing is pushed', async () => {
    const { seed, work, origin } = repos();
    write(work, 'a.txt', 'one\nFEATURE\nthree\n');
    commit(work, 'feature edit');
    git(work, 'push', '-q', 'origin', 'feature');
    const pushed = git(origin, 'rev-parse', 'feature');
    write(seed, 'a.txt', 'one\nBASE\nthree\n');
    commit(seed, 'base edit');
    git(seed, 'push', '-q', 'origin', 'main');

    const result = await run(work, request());
    expect(result).toMatchObject({ outcome: 'conflict', conflictedPaths: ['a.txt'] });
    if (result.kind !== 'integrate') return;
    // The implementer is told what the base changed there.
    expect(result.baseDiff).toContain('+BASE');
    expect(result.baseDiff).not.toContain('FEATURE');
    expect(git(origin, 'rev-parse', 'feature')).toBe(pushed);
    // The merge was aborted: the checkout is clean.
    expect(git(work, 'status', '--porcelain')).toBe('');
  });

  // openspec factory-integration 5.2 (D10): a run stacked on a blocker that is
  // squash-merged after a late fix still merges the base without a conflict.
  test("a stacked branch follows its blocker's late fix, then merges the squashed base cleanly", async () => {
    const { seed, work } = repos();
    // The blocker's branch, pushed.
    git(seed, 'checkout', '-q', '-b', 'blocker');
    write(seed, 'b.txt', 'one\ntwo\n');
    commit(seed, 'blocker work');
    git(seed, 'push', '-q', 'origin', 'blocker');
    // The stacked run starts on it.
    git(work, 'fetch', '-q', 'origin', 'blocker');
    git(work, 'checkout', '-q', '-B', 'feature', 'origin/blocker');
    write(work, 'c.txt', 'stacked\n');
    commit(work, 'stacked work');
    // A late fix on the blocker, then early integration of the stacked run.
    write(seed, 'b.txt', 'one\nTWO\n');
    commit(seed, 'blocker late fix');
    git(seed, 'push', '-q', 'origin', 'blocker');
    expect(await run(work, request({ baseBranch: 'blocker' }))).toMatchObject({
      outcome: 'merged',
    });
    // The blocker lands as one squashed commit.
    git(seed, 'checkout', '-q', 'main');
    git(seed, 'merge', '-q', '--squash', 'blocker');
    git(seed, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'blocker (#7)');
    git(seed, 'push', '-q', 'origin', 'main');
    // Retargeted to main, the stacked branch merges the base without a conflict.
    const result = await run(work, request({ baseBranch: 'main' }));
    expect(result).toMatchObject({ outcome: 'merged', conflictedPaths: [] });
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('one\nTWO\n');
  });

  test('a failing integration check leaves the branch as it was and pushes nothing', async () => {
    const { seed, work } = repos();
    write(work, 'b.txt', 'mine\n');
    commit(work, 'feature work');
    const mine = git(work, 'rev-parse', 'HEAD');
    write(seed, 'c.txt', 'theirs\n');
    commit(seed, 'base moved');
    git(seed, 'push', '-q', 'origin', 'main');

    const result = await run(work, request({ checks: ['exit 1'] }));
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(mine);
  });
});
