/**
 * How the whole issue factory handles failures: infrastructure failures are
 * retried after the configured delay and then twice that; agent failures, and
 * infrastructure failures that used up their retries, fail the factory run
 * and hand the issue back. See `helpers/factory-harness.ts` for the seam.
 *
 * Tests observe GitHub's state (requests, comments, labels, pull requests),
 * the project's origin, what the agent was asked, and `status`.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
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

/** `retry_delay_minutes` of the harness settings. */
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

function agent(implement: FakeAgentTurn = writesHello, fix?: FakeAgentTurn): Turns {
  return (step) => [
    (call) => {
      asked.push(step.step);
      return step.step === 'implement' ? implement(call) : (fix ?? implement)(call);
    },
  ];
}

async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

const assignAttempts = () =>
  h.github.requests.filter((r) => r.endsWith('/issues/7/assignees')).length;
const issue = () => h.github.issues.get(7)!;

describe('infrastructure failures', () => {
  test('are retried after the delay, then after twice the delay, then the run fails', async () => {
    h.github.fail('POST', '/issues/7/assignees');
    const { factory: f, store } = h.factory(agent());

    await tick(f);
    expect(assignAttempts()).toBe(1);
    const waiting = await h.status();
    expect(waiting).toContain('queued');
    expect(waiting).toContain('retrying after');

    h.clock.advance(DELAY - MIN);
    await tick(f);
    expect(assignAttempts()).toBe(1);
    h.clock.advance(MIN);
    await tick(f);
    expect(assignAttempts()).toBe(2);

    h.clock.advance(2 * DELAY - MIN);
    await tick(f);
    expect(assignAttempts()).toBe(2);
    h.clock.advance(MIN);
    await tick(f);
    expect(assignAttempts()).toBe(3);

    h.clock.advance(10 * DELAY);
    await tick(f);
    store.close();
    expect(assignAttempts()).toBe(3);
    expect(asked).toEqual([]);
    const out = await h.status();
    expect(out).toContain('failed');
    expect(out).toContain('after 2 retries');
    // Handed back with the reason.
    expect(issue().comments.at(-1)!.body).toContain('could not claim the issue');
    expect(issue().labels).not.toContain('agent-in-progress');
  });

  test('a retry that succeeds opens the pull request, with one claim comment', async () => {
    h.github.fail('GET', '/repos/acme/app');
    const { factory: f, store } = h.factory(agent());
    await tick(f);
    expect(h.github.pulls).toHaveLength(0);

    h.github.heal('GET', '/repos/acme/app');
    h.clock.advance(DELAY);
    await tick(f);
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    expect(issue().comments).toHaveLength(1);
    expect(await h.status()).toContain('waiting_ci');
  });

  test('a run waiting to retry holds no concurrency slot', async () => {
    h.github.addIssue({ number: 8, author: LOGIN, title: 'Another', labels: ['ready-for-agent'] });
    h.github.fail('POST', '/issues/7/assignees');
    const { factory: f, store } = h.factory(agent(), { limits: { concurrency: 1, daily: 10 } });
    await tick(f);
    await tick(f);
    store.close();

    expect(h.github.pulls.map((p) => p.title)).toEqual(['Another']);
  });
});

describe('infrastructure failures, more cases', () => {
  test('a due retry starts even when it is the only slot, and claims with one comment', async () => {
    h.github.fail('POST', '/issues/7/assignees');
    const { factory: f, store } = h.factory(agent(), { limits: { concurrency: 1, daily: 10 } });
    await tick(f);
    h.github.heal('POST', '/issues/7/assignees');
    h.clock.advance(DELAY);
    await tick(f);
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    expect(issue().comments.map((c) => c.body)).toHaveLength(1);
    expect(issue().comments[0].body).toContain('is working on this issue');
  });

  test('reading CI is retried after the delay, then twice the delay, then the run fails', async () => {
    const { factory: f, store } = h.factory(agent());
    await tick(f);
    const number = h.github.pulls[0].number;
    h.github.fail('GET', `/pulls/${number}`);
    const reads = () => h.github.requests.filter((r) => r.endsWith(`/pulls/${number}`)).length;

    h.clock.advance(3 * MIN);
    await tick(f);
    expect(reads()).toBe(1);
    expect(await h.status()).toContain('retrying after');
    h.clock.advance(DELAY);
    await tick(f);
    expect(reads()).toBe(2);
    h.clock.advance(2 * DELAY);
    await tick(f);
    store.close();
    expect(reads()).toBe(3);
    const out = await h.status();
    expect(out).toContain('failed');
    expect(out).toContain('could not read the CI');
    expect(h.github.pulls).toHaveLength(1);
  });

  test("the model provider rate-limiting the agent is the infrastructure's failure", async () => {
    let first = true;
    const { factory: f, store } = h.factory(
      agent((call) => {
        if (first) {
          first = false;
          throw new Error('API Error: 429 rate limit exceeded');
        }
        return writesHello(call);
      }),
    );
    await tick(f);
    expect(await h.status()).toContain('queued');
    h.clock.advance(DELAY);
    await tick(f);
    store.close();

    expect(asked).toEqual(['implement', 'implement']);
    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.pulls[0].head).toEndWith('-retry1');
  });

  test('runs that failed before hand-backs existed are not handed back after an upgrade', async () => {
    // A state file from before the hand-back columns, with a failed run in it.
    mkdirSync(h.home, { recursive: true });
    const old = new Database(join(h.home, 'state.db'));
    old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue_number INTEGER NOT NULL,
      state TEXT NOT NULL, pr_url TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.exec(
      `INSERT INTO runs VALUES ('r-7-old', 'acme/app', 7, 'failed', NULL, 'old', '2026-11-01', '2026-11-01')`,
    );
    old.close();
    issue().labels = ['ready-for-agent'];

    const { factory: f, store } = h.factory(agent());
    await tick(f);
    store.close();
    // Not handed back (no comment stripped the label); the ready label starts a new run.
    expect(asked).toEqual(['implement']);
    expect(issue().comments.some((c) => c.body.includes('could not finish'))).toBe(false);
  });
});

describe('agent failures', () => {
  const gives_up: FakeAgentTurn = () => {
    throw new Error('I cannot work out what the issue wants.');
  };

  test('are not retried: the run fails and the issue is handed back with the reason', async () => {
    const { factory: f, store } = h.factory(agent(gives_up));
    await tick(f);
    h.clock.advance(10 * DELAY);
    await tick(f);
    store.close();

    expect(asked).toEqual(['implement']);
    const out = await h.status();
    expect(out).toContain('failed');
    expect(out).toContain('agent failure');
    expect(issue().labels).toEqual([]);
    const handBack = issue().comments.at(-1)!.body;
    expect(handBack).toContain('I cannot work out what the issue wants.');
    expect(handBack).toContain('ready-for-agent');
  });

  test('a failed run keeps its branch and pull request', async () => {
    let n = 0;
    const { factory: f, store } = h.factory(
      agent(writesHello, ({ cwd }) => {
        writeFileSync(join(cwd, 'hello.txt'), `attempt ${++n}\n`);
        return 'Tried again.';
      }),
    );
    await tick(f);
    const pull = h.github.pulls[0];
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'still red' }];
    for (let i = 0; i < 5; i++) {
      h.clock.advance(3 * MIN);
      await tick(f);
    }
    store.close();

    expect(await h.status()).toContain('failed');
    expect(h.github.pulls).toHaveLength(1);
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('attempt 3');
    expect(issue().labels).toEqual([]);
    expect(issue().comments.at(-1)!.body).toContain('CI did not pass after 3 fix attempts');
  });

  test('adding the ready label again admits a new run', async () => {
    let first = true;
    const { factory: f, store } = h.factory(
      agent((call) => {
        if (first) {
          first = false;
          throw new Error('Not this time.');
        }
        return writesHello(call);
      }),
    );
    await tick(f);
    issue().labels.push('ready-for-agent');
    await tick(f);
    store.close();

    expect(asked).toEqual(['implement', 'implement']);
    expect(h.github.pulls).toHaveLength(1);
    const out = await h.status();
    expect(out.match(/acme\/app#7/g)).toHaveLength(2);
    expect(out).toContain('failed');
    expect(out).toContain('waiting_ci');
  });

  test('an issue that could not be handed back yet is not admitted again', async () => {
    let first = true;
    const { factory: f, store } = h.factory(
      agent((call) => {
        if (first) {
          first = false;
          throw new Error('Not this time.');
        }
        return writesHello(call);
      }),
    );
    h.github.fail('DELETE', '/labels/agent-in-progress');
    await tick(f);
    // The labels were not reset; a ready label on the issue must not start a run.
    issue().labels.push('ready-for-agent');
    await tick(f);
    expect(asked).toEqual(['implement']);

    // GitHub recovers: the hand-back completes, then a new ready label is a new run.
    h.github.heal('DELETE', '/labels/agent-in-progress');
    await tick(f);
    expect(issue().labels).toEqual([]);
    issue().labels.push('ready-for-agent');
    await tick(f);
    store.close();
    expect(asked).toEqual(['implement', 'implement']);
  });
});
