/**
 * Restarting the issue factory: a second factory over the same state file
 * and workspaces stands for the restarted process; it reconciles before its
 * first tick. A stop in the middle of a factory run is a request to GitHub
 * that never answers (the process stopped waiting on it). See
 * `helpers/factory-harness.ts` for the seam.
 *
 * Tests observe GitHub's state, the project's origin, the workspaces on disk,
 * what the agent was asked, and `status`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs';
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
import type { FakeAgentTurn } from './helpers/step-fakes.js';

const POLL = 3 * MIN;
const DELAY = 30 * MIN;

let h: FactoryHarness;
let asked: string[];
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

function agent(fix: FakeAgentTurn = writesHello): Turns {
  return (step) => [
    (call) => {
      asked.push(step.step);
      return step.step === 'implement' ? writesHello(call) : fix(call);
    },
  ];
}

async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

/** The restarted factory, reconciled. */
async function restart(turns: Turns = agent()) {
  const built = h.factory(turns);
  await built.factory.reconcile();
  return built;
}

/** A first factory that took #7 to its draft pull request, then stopped. */
async function waitingForCi() {
  const first = h.factory(agent());
  await tick(first.factory);
  first.store.close();
  return h.github.pulls[0];
}

const runDir = () => join(h.home, 'runs', readdirSync(join(h.home, 'runs'))[0]);

describe('restarting the factory', () => {
  test('mid-run neither loses the factory run nor starts a second one for the issue', async () => {
    h.github.hang('POST', '/issues/7/assignees');
    const first = h.factory(agent());
    await first.factory.tick();
    // The first process stops while it waits on GitHub to assign the issue.
    for (let i = 0; i < 100 && h.github.hung.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(h.github.hung).toHaveLength(1);
    first.store.close();
    h.github.heal('POST', '/issues/7/assignees');

    const { factory: f, store } = await restart();
    await tick(f);
    const waiting = await h.status();
    expect(waiting.match(/acme\/app#7/g)).toHaveLength(1);
    expect(waiting).toContain('interrupted by a restart');

    h.clock.advance(DELAY);
    await tick(f);
    h.clock.advance(DELAY);
    await tick(f);
    store.close();
    expect(asked).toEqual(['implement']);
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.issues.get(7)!.comments).toHaveLength(1);
    expect((await h.status()).match(/acme\/app#7/g)).toHaveLength(1);
  });

  test('a pull request opened just before the stop is adopted, not opened again', async () => {
    const pull = await waitingForCi();
    // The state file as a stop right after opening the pull request leaves it.
    const store = h.factory().store;
    const [run] = store.list();
    store.save({ ...run, state: 'working', prUrl: null });
    store.close();

    const { factory: f, store: again } = await restart();
    h.clock.advance(POLL);
    await tick(f);
    again.close();
    expect(h.github.pulls).toEqual([pull]);
    expect(asked).toEqual(['implement']);
    const out = await h.status();
    expect(out).toContain('waiting_ci');
    expect(out).toContain(pull.url);
  });

  test('a pull request merged while the factory was down is recorded as merged, and cleaned up', async () => {
    const pull = await waitingForCi();
    pull.merged = true;
    pull.state = 'closed';

    const { store } = await restart();
    store.close();
    expect(await h.status()).toContain('merged');
    expect(h.github.deletedBranches).toEqual([pull.head]);
    expect(existsSync(join(runDir(), 'worktree'))).toBe(false);
  });

  test('a factory run whose workspace disappeared retries as an infrastructure failure', async () => {
    const pull = await waitingForCi();
    rmSync(join(runDir(), 'worktree'), { recursive: true, force: true });

    const { factory: f, store } = await restart(
      agent(({ cwd }) => {
        writeFileSync(join(cwd, 'hello.txt'), 'hello world\n');
        return 'Fixed the greeting.';
      }),
    );
    const out = await h.status();
    expect(out).toContain('the workspace disappeared');
    expect(out).toContain('retrying after');

    // CI fails; the fix runs in a workspace recreated from the pushed branch.
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
    h.clock.advance(DELAY);
    await tick(f);
    store.close();
    expect(asked).toEqual(['implement', 'fix']);
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('hello world');
  });

  test('a factory run waiting for CI resumes polling', async () => {
    const pull = await waitingForCi();
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'success' }];

    const { factory: f, store } = await restart();
    await tick(f);
    store.close();
    expect(pull.draft).toBe(false);
    expect(await h.status()).toContain('ready');
  });

  test('an adopted pull request is fixed with the session its step recorded, or a new one', async () => {
    const pull = await waitingForCi();
    const sessions: Array<string | undefined> = [];
    const fixTurn: Turns = (step) => [
      (call) => {
        asked.push(step.step);
        if (step.step === 'fix') sessions.push(call.sessionId);
        writeFileSync(join(call.cwd, 'hello.txt'), `fixed ${sessions.length}\n`);
        return 'Fixed.';
      },
    ];
    // Stopped right after opening the pull request: the state file has no session.
    const store = h.factory().store;
    const [run] = store.list();
    store.save({ ...run, state: 'working', prUrl: null, sessionId: undefined });
    store.close();

    const { factory: f, store: again } = await restart(fixTurn);
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
    h.clock.advance(POLL);
    await tick(f);
    // Its exit marker is gone too: the next fix starts a new session.
    rmSync(join(runDir(), 'exit.json'), { force: true });
    const [adopted] = again.list();
    again.save({ ...adopted, sessionId: undefined });
    h.clock.advance(POLL);
    await tick(f);
    again.close();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe('session-1');
    expect(sessions[1]).toBeUndefined();
  });

  test('when GitHub cannot be asked after a restart, it is asked again; no second pull request', async () => {
    const pull = await waitingForCi();
    const store = h.factory().store;
    const [run] = store.list();
    store.save({ ...run, state: 'working', prUrl: null });
    store.close();
    h.github.fail('GET', '/repos/acme/app/pulls');

    const { factory: f, store: again } = await restart();
    await tick(f);
    expect(h.github.pulls).toHaveLength(1);
    expect(await h.status()).toContain('checking GitHub again');

    h.github.heal('GET', '/repos/acme/app/pulls');
    await tick(f);
    again.close();
    expect(h.github.pulls).toEqual([pull]);
    expect(asked).toEqual(['implement']);
    expect(await h.status()).toContain('waiting_ci');
  });

  test('a branch pushed without a pull request is deleted before the retry', async () => {
    const pull = await waitingForCi();
    pull.state = 'closed'; // no open pull request from the branch any more
    const store = h.factory().store;
    const [run] = store.list();
    store.save({ ...run, state: 'working', prUrl: null });
    store.close();

    const { factory: f, store: again } = await restart();
    h.clock.advance(DELAY);
    await tick(f);
    again.close();
    expect(h.github.deletedBranches).toEqual([pull.head]);
    expect(h.github.pulls).toHaveLength(2);
    expect(h.github.pulls[1].head).toEndWith('-retry1');
  });

  test('a merge seen on restart whose cleanup fails is cleaned up later, never handed back', async () => {
    const pull = await waitingForCi();
    pull.merged = true;
    pull.state = 'closed';
    h.github.fail('DELETE', `/git/refs/heads/${pull.head}`);

    const { factory: f, store } = await restart();
    expect(await h.status()).toContain('cleanup incomplete');
    h.github.heal('DELETE', `/git/refs/heads/${pull.head}`);
    h.clock.advance(POLL);
    await tick(f);
    store.close();

    const out = await h.status();
    expect(out).toContain('merged');
    expect(out).not.toContain('cleanup incomplete');
    expect(h.github.issues.get(7)!.comments.some((c) => c.body.includes('could not finish'))).toBe(
      false,
    );
  });

  test('a step the previous process left running is stopped before anything else', async () => {
    await waitingForCi();
    // A step child of the previous process, still running in the run's directory.
    const leftover = Bun.spawn(['sleep', '60']);
    writeFileSync(join(runDir(), 'step.pid'), String(leftover.pid));
    const store = h.factory().store;
    const [run] = store.list();
    store.save({ ...run, state: 'fixing' });
    store.close();

    const { store: again } = await restart();
    again.close();
    await leftover.exited;
    expect(leftover.signalCode).toBe('SIGTERM');
    expect(existsSync(join(runDir(), 'step.pid'))).toBe(false);
  });
});
