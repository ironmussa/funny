/**
 * The whole issue factory after the draft pull request: following its CI
 * every 3 minutes, fixing failing checks and conflicts with the same agent
 * session, and marking it ready once green. See `helpers/factory-harness.ts`
 * for the seam (fakes only at the edges).
 *
 * Tests observe GitHub's state (the pull request, its draft flag), the
 * project's origin, what the agent was asked, `status` and the event file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  createFactoryHarness,
  git,
  LOGIN,
  MIN,
  writesHello,
  type FactoryHarness,
  type Turns,
} from './helpers/factory-harness.js';
import type { FakeCheck } from './helpers/fake-github-api.js';
import type { FakeAgentTurn } from './helpers/step-fakes.js';

const POLL = 3 * MIN;
const green: FakeCheck[] = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
const red: FakeCheck[] = [
  {
    name: 'unit',
    status: 'completed',
    conclusion: 'failure',
    log: 'FAIL greeting.test.ts\nexpected "hello world", got "hello"',
  },
];

let h: FactoryHarness;
/** What the agent was asked, in order: the step, the session it resumed, the prompt. */
let asked: Array<{ step: string; sessionId?: string; prompt: string }>;
beforeEach(() => {
  h = createFactoryHarness();
  h.github.addIssue({
    number: 7,
    author: LOGIN,
    title: 'Add a greeting',
    labels: ['ready-for-agent'],
  });
  asked = [];
});
afterEach(() => h.cleanup());

/** Records every agent turn, then plays `implement` or `fix`. */
function agent(fix: FakeAgentTurn = writesWorld): Turns {
  return (step) => [
    (call) => {
      asked.push({ step: step.step, sessionId: call.sessionId, prompt: call.prompt });
      return step.step === 'implement' ? writesHello(call) : fix(call);
    },
  ];
}

const writesWorld: FakeAgentTurn = ({ cwd }) => {
  writeFileSync(join(cwd, 'hello.txt'), 'hello world\n');
  return 'Fixed the greeting.';
};

/** Tick and wait for the work it started. */
async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

const pull = () => h.github.pulls[0];
const states = () =>
  h
    .events()
    .filter((e) => e.event_type === 'factory.run_state')
    .map((e) => e.data.state);

describe('CI follow-up', () => {
  test('green CI marks the pull request ready for review, looking only every 3 minutes', async () => {
    const { factory: f, store } = h.factory(agent());
    await tick(f);
    expect(pull().draft).toBe(true);

    pull().checks = green;
    h.clock.advance(MIN);
    await tick(f);
    expect(pull().draft).toBe(true);

    h.clock.advance(POLL);
    await tick(f);
    store.close();
    expect(pull().draft).toBe(false);
    expect(await h.status()).toContain('ready');
    expect(states()).toEqual(['queued', 'claiming', 'working', 'pr_open', 'waiting_ci', 'ready']);
  });

  test('a failing check is fixed by the same agent session, with the check and its log, and pushed', async () => {
    const fixAndGoGreen: FakeAgentTurn = (call) => {
      pull().checks = green; // CI reruns on the pushed fix
      return writesWorld(call);
    };
    const { factory: f, store } = h.factory(agent(fixAndGoGreen));
    await tick(f);
    pull().checks = red;
    h.clock.advance(POLL);
    await tick(f);
    h.clock.advance(POLL);
    await tick(f);
    store.close();

    expect(asked.map((a) => a.step)).toEqual(['implement', 'fix']);
    const implementSession = 'session-1';
    expect(asked[1].sessionId).toBe(implementSession);
    expect(asked[1].prompt).toContain('unit');
    expect(asked[1].prompt).toContain('expected "hello world", got "hello"');
    expect(git(h.origin, 'show', `${pull().head}:hello.txt`)).toBe('hello world');
    expect(pull().draft).toBe(false);
    expect(states()).toEqual([
      'queued',
      'claiming',
      'working',
      'pr_open',
      'waiting_ci',
      'fixing',
      'waiting_ci',
      'ready',
    ]);
  });

  test('a conflict with the base is rebased by the same agent and pushed', async () => {
    const { factory: f, store } = h.factory(
      agent((call) => {
        // The agent rebases onto the moved base and resolves the conflict.
        try {
          execFileSync('git', ['rebase', 'origin/main'], { cwd: call.cwd, stdio: 'ignore' });
        } catch {
          writeFileSync(join(call.cwd, 'hello.txt'), 'hello\n');
          execFileSync('git', ['add', 'hello.txt'], { cwd: call.cwd });
          execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
            cwd: call.cwd,
          });
        }
        pull().mergeable = true;
        pull().checks = green;
        return 'Rebased onto main.';
      }),
    );
    await tick(f);

    // A teammate changes the same file on main: the pull request conflicts.
    const other = mkdtempSync(join(h.root, 'teammate-'));
    git(h.root, 'clone', '-q', h.origin, other);
    git(other, 'config', 'user.name', 'Teammate');
    git(other, 'config', 'user.email', 'mate@example.com');
    writeFileSync(join(other, 'hello.txt'), 'hey\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'Greeting on main');
    git(other, 'push', '-q', 'origin', 'main');
    pull().mergeable = false;

    h.clock.advance(POLL);
    await tick(f);
    h.clock.advance(POLL);
    await tick(f);
    store.close();

    expect(asked.map((a) => a.step)).toEqual(['implement', 'fix']);
    expect(asked[1].sessionId).toBe('session-1');
    expect(asked[1].prompt).toContain('git rebase origin/main');
    expect(git(h.origin, 'merge-base', '--is-ancestor', 'main', pull().head)).toBe('');
    expect(pull().draft).toBe(false);
  });

  test('after three fix attempts without green CI the run fails', async () => {
    let n = 0;
    const { factory: f, store } = h.factory(
      agent(({ cwd }) => {
        writeFileSync(join(cwd, 'hello.txt'), `attempt ${++n}\n`);
        return 'Tried again.';
      }),
    );
    await tick(f);
    pull().checks = red;
    for (let i = 0; i < 5; i++) {
      h.clock.advance(POLL);
      await tick(f);
    }
    store.close();

    expect(asked.filter((a) => a.step === 'fix')).toHaveLength(3);
    expect(pull().draft).toBe(true);
    const out = await h.status();
    expect(out).toContain('failed');
    expect(out).toContain('CI did not pass after 3 fix attempts');
    expect(states().at(-1)).toBe('failed');
  });

  test('a run waiting for CI does not hold a concurrency slot', async () => {
    h.github.addIssue({ number: 8, author: LOGIN, title: 'Another', labels: ['ready-for-agent'] });
    const { factory: f, store } = h.factory(agent(), { limits: { concurrency: 1, daily: 10 } });
    await tick(f);
    // #7 is waiting for CI (still running); #8 is admitted on the next tick.
    pull().checks = [{ name: 'unit', status: 'in_progress' }];
    await tick(f);
    store.close();

    expect(h.github.pulls).toHaveLength(2);
    const out = await h.status();
    expect(out.match(/waiting_ci/g)).toHaveLength(2);
  });

  test('no check reported yet is not green; with none after 15 minutes the repository has no CI', async () => {
    const { factory: f, store } = h.factory(agent());
    await tick(f);
    // GitHub has not reported any check on the head commit yet.
    h.clock.advance(POLL);
    await tick(f);
    expect(pull().draft).toBe(true);
    expect(await h.status()).toContain('waiting_ci');

    for (let i = 0; i < 5; i++) {
      h.clock.advance(POLL);
      await tick(f);
    }
    store.close();
    expect(pull().draft).toBe(false);
    expect(await h.status()).toContain('no CI');
  });

  test('a fix the agent could not finish uses up an attempt and the run keeps waiting', async () => {
    let n = 0;
    const { factory: f, store } = h.factory(
      agent((call) => {
        // The first fix changes nothing; the second fixes it and CI goes green.
        if (++n === 1) return 'I could not find the cause.';
        pull().checks = green;
        return writesWorld(call);
      }),
    );
    await tick(f);
    pull().checks = red;
    for (let i = 0; i < 3; i++) {
      h.clock.advance(POLL);
      await tick(f);
    }
    store.close();

    expect(asked.filter((a) => a.step === 'fix')).toHaveLength(2);
    expect(pull().draft).toBe(false);
    expect(states()).toEqual([
      'queued',
      'claiming',
      'working',
      'pr_open',
      'waiting_ci',
      'fixing',
      'waiting_ci',
      'fixing',
      'waiting_ci',
      'ready',
    ]);
  });
});
