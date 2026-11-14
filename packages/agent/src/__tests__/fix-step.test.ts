/**
 * Step runner seam: the `fix` step against a real temporary git repository
 * (with a bare `origin`) and a fake agent. The branch is the one a previous
 * `implement` pushed.
 *
 * Tests observe only what leaves the step: the branch on the origin, what the
 * agent was asked (and with which session), the printed lines and the exit
 * marker.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runFixStep, type FixStepSpec } from '../steps/fix.js';
import { fakeAgents, type FakeAgentTurn } from './helpers/step-fakes.js';

const AUTHOR = { name: 'Factory Owner', email: 'owner@example.com' };
const BRANCH = 'factory/issue-7';

let root: string;
let work: string;
let origin: string;
let printed: string[];

/** Hook-provided GIT_* variables would point git at the wrong repository. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true' };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_EDITOR') delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();
}
function gitStatus(cwd: string, ...args: string[]): number {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'funny-fix-step-'));
  origin = join(root, 'origin.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanGitEnv() });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env: cleanGitEnv() });
  git(work, 'config', 'user.name', 'Someone Else');
  git(work, 'config', 'user.email', 'someone@example.com');
  writeFileSync(join(work, 'hello.txt'), 'hi\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'initial');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  // What `implement` left: the run's branch with its commit, pushed.
  git(work, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(work, 'hello.txt'), 'hullo\n');
  git(work, 'commit', '-q', '-am', 'Add a greeting (#7)');
  git(work, 'push', '-q', '-u', 'origin', BRANCH);
  printed = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function spec(overrides: Partial<FixStepSpec> = {}): FixStepSpec {
  return {
    runId: 'run-1',
    sessionId: 'session-from-implement',
    issue: { number: 7, title: 'Add a greeting' },
    prUrl: 'https://github.com/acme/demo/pull/1',
    base: 'main',
    branch: BRANCH,
    author: AUTHOR,
    model: 'sonnet',
    problem: {
      kind: 'checks',
      checks: [{ name: 'unit', conclusion: 'failure', excerpt: 'expected "hello", got "hullo"' }],
    },
    eventsPath: join(root, 'events.jsonl'),
    exitMarkerPath: join(root, 'exit.json'),
    ...overrides,
  };
}

const marker = () => JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'));

/** Another contributor changes hello.txt on main, so the run's branch conflicts. */
function moveBaseWithConflict(): void {
  const other = join(root, 'other');
  execFileSync('git', ['clone', '-q', origin, other], { env: cleanGitEnv() });
  git(other, 'config', 'user.name', 'Teammate');
  git(other, 'config', 'user.email', 'mate@example.com');
  writeFileSync(join(other, 'hello.txt'), 'hey\n');
  writeFileSync(join(other, 'other.txt'), 'from main\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'Change the greeting on main');
  git(other, 'push', '-q', 'origin', 'main');
}

describe('fix step', () => {
  test('resumes the run session with the failing checks and pushes the fix', async () => {
    const agents = fakeAgents([
      ({ cwd }) => {
        writeFileSync(join(cwd, 'hello.txt'), 'hello\n');
        return 'Fixed the greeting.';
      },
    ]);
    const outcome = await runFixStep(spec(), { cwd: work, agents, print: (l) => printed.push(l) });

    expect(outcome).toEqual({ kind: 'pushed', sessionId: 'session-from-implement' });
    expect(marker().kind).toBe('pushed');
    // The same session, told which check failed and how.
    expect(agents.calls).toHaveLength(1);
    expect(agents.calls[0].sessionId).toBe('session-from-implement');
    expect(agents.calls[0].prompt).toContain('unit');
    expect(agents.calls[0].prompt).toContain('expected "hello", got "hullo"');
    // The fix is on the pushed branch, authored as configured.
    expect(git(origin, 'show', `${BRANCH}:hello.txt`)).toBe('hello');
    expect(git(origin, 'log', '-1', '--format=%an <%ae>', BRANCH)).toBe(
      'Factory Owner <owner@example.com>',
    );
    expect(printed).toContain('session_id=session-from-implement');
  });

  test('a conflict is rebased onto the moved base by the same agent and force-pushed', async () => {
    moveBaseWithConflict();
    const agents = fakeAgents([
      ({ cwd }) => {
        // The agent rebases, resolves the conflict and continues.
        expect(gitStatus(cwd, 'rebase', 'origin/main')).not.toBe(0);
        writeFileSync(join(cwd, 'hello.txt'), 'hello\n');
        git(cwd, 'add', 'hello.txt');
        git(cwd, 'rebase', '--continue');
        return 'Rebased onto main and kept the greeting.';
      },
    ]);
    const outcome = await runFixStep(spec({ problem: { kind: 'conflict' } }), {
      cwd: work,
      agents,
      print: (l) => printed.push(l),
    });

    expect(outcome).toEqual({ kind: 'pushed', sessionId: 'session-from-implement' });
    expect(agents.calls[0].sessionId).toBe('session-from-implement');
    expect(agents.calls[0].prompt).toContain('git rebase origin/main');
    // The pushed branch now sits on top of main, with the conflict resolved.
    expect(gitStatus(origin, 'merge-base', '--is-ancestor', 'main', BRANCH)).toBe(0);
    expect(git(origin, 'show', `${BRANCH}:hello.txt`)).toBe('hello');
    expect(git(origin, 'show', `${BRANCH}:other.txt`)).toBe('from main');
  });

  test('a rebase the agent leaves unfinished fails as an agent failure and pushes nothing', async () => {
    moveBaseWithConflict();
    const before = git(origin, 'rev-parse', BRANCH);
    const agents = fakeAgents([
      ({ cwd }) => {
        gitStatus(cwd, 'rebase', 'origin/main');
        return 'I could not resolve it.';
      },
    ]);
    const outcome = await runFixStep(spec({ problem: { kind: 'conflict' } }), {
      cwd: work,
      agents,
      print: () => {},
    });

    expect(outcome).toMatchObject({ kind: 'failed', failure: 'agent' });
    expect(marker()).toMatchObject({ kind: 'failed', failure: 'agent' });
    expect(git(origin, 'rev-parse', BRANCH)).toBe(before);
  });

  test('local checks that keep failing end as an agent failure, with in-place fixes tried', async () => {
    const before = git(origin, 'rev-parse', BRANCH);
    const turns: FakeAgentTurn[] = [() => 'Tried.', () => 'Tried again.', () => 'Gave up.'];
    const agents = fakeAgents(turns);
    const outcome = await runFixStep(spec({ checkCommand: 'grep -q hello hello.txt' }), {
      cwd: work,
      agents,
      print: () => {},
    });

    expect(outcome).toMatchObject({ kind: 'failed', failure: 'agent' });
    // The fix, then two in-place fixes after the local checks failed.
    expect(agents.calls).toHaveLength(3);
    expect(agents.calls.every((c) => c.sessionId === 'session-from-implement')).toBe(true);
    expect(agents.calls[1].prompt).toContain('grep -q hello hello.txt');
    expect(git(origin, 'rev-parse', BRANCH)).toBe(before);
  });

  test('a fix that changes nothing fails as an agent failure and pushes nothing', async () => {
    const before = git(origin, 'rev-parse', BRANCH);
    const agents = fakeAgents([() => 'Nothing to change, I think.']);
    const outcome = await runFixStep(spec(), { cwd: work, agents, print: () => {} });

    expect(outcome).toMatchObject({ kind: 'failed', failure: 'agent' });
    expect(marker().reason).toContain('changed nothing');
    expect(git(origin, 'rev-parse', BRANCH)).toBe(before);
  });
});
