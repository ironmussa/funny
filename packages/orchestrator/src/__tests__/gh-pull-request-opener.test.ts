/**
 * GhPullRequestOpener against a fake `gh` executable on PATH: what `gh` is
 * asked to do, and how its answer becomes a result.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GhPullRequestOpener } from '../adapters/gh-pull-request-opener.js';

let dir: string;
let savedPath: string | undefined;

/** Installs a `gh` that records its arguments, one per line, then runs `script`. */
function fakeGh(script: string): void {
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\n${script}\n`);
  chmodSync(gh, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-fake-gh-'));
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

const pr = {
  cwd: tmpdir(),
  title: 'Add a greeting',
  body: 'Closes #7',
  base: 'main',
  head: 'factory/issue-7',
};

describe('GhPullRequestOpener', () => {
  test('opens a draft from the head branch against the base and returns its URL', async () => {
    fakeGh("echo 'Creating pull request…'; echo 'https://github.com/acme/demo/pull/9'");

    const result = await new GhPullRequestOpener().openDraft(pr);

    expect(result).toEqual({ ok: true, url: 'https://github.com/acme/demo/pull/9' });
    const args = readFileSync(join(dir, 'args'), 'utf8').trim().split('\n');
    expect(args.slice(0, 3)).toEqual(['pr', 'create', '--draft']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--base',
        'main',
        '--head',
        'factory/issue-7',
        '--body',
        'Closes #7',
      ]),
    );
  });

  test('a failing gh becomes an error carrying what gh said', async () => {
    fakeGh("echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1");

    const result = await new GhPullRequestOpener().openDraft(pr);

    expect(result).toEqual({
      ok: false,
      error: 'HTTP 403: Resource not accessible by integration',
    });
  });
});
